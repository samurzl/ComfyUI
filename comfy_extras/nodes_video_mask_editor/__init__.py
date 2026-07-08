import json
import os
import uuid

import numpy as np
import torch
import torch.nn.functional as F
import kornia
from PIL import Image
from typing_extensions import override

import comfy.model_management
import comfy.utils
import folder_paths
import node_helpers
from comfy_api.latest import ComfyExtension, Input, InputImpl, Types, io, ui


WEB_DIRECTORY = "./web"
_INPAINT_COLOR = (0.4, 1.0, 0.0)


def _load_keyframes(mask_data, frame_count, height, width):
    masks = {}
    if not mask_data:
        return masks

    data = json.loads(mask_data)
    frames = data.get("frames", [])
    if not frames:
        return masks

    tile_width = int(data["width"])
    tile_height = int(data["height"])
    columns = int(data["columns"])
    if tile_width <= 0 or tile_height <= 0 or columns <= 0:
        raise ValueError("Invalid video mask editor atlas dimensions")

    path = folder_paths.get_annotated_filepath(data["file"])
    atlas = node_helpers.pillow(Image.open, path).convert("RGBA")
    for index, frame in enumerate(frames):
        frame = int(frame)
        if frame < 0 or frame >= frame_count:
            continue
        x = index % columns * tile_width
        y = index // columns * tile_height
        tile = atlas.crop((x, y, x + tile_width, y + tile_height))
        if tile.size != (width, height):
            tile = tile.resize((width, height), Image.Resampling.BILINEAR)
        alpha = np.asarray(tile.getchannel("A"), dtype=np.float32) / 255.0
        mask = torch.from_numpy(alpha.copy())
        if mask.any():
            masks[frame] = mask
    return masks


def _tracked_masks(result, length, height, width):
    device = comfy.model_management.intermediate_device()
    if isinstance(result, dict):
        packed = result["packed_masks"]
        if packed is None:
            return torch.zeros(length, height, width, device=device)
        from comfy.ldm.sam3.tracker import unpack_masks
        masks = unpack_masks(packed.to(device)).any(dim=1).float()
    else:
        masks = (result.to(device) > 0).any(dim=1).float()
    return F.interpolate(masks.unsqueeze(1), size=(height, width), mode="bilinear", align_corners=False)[:, 0]


def _track_video(images, keyframes, model, tracking):
    frame_count, height, width, _ = images.shape
    device = comfy.model_management.get_torch_device()
    dtype = model.model.get_dtype()
    sam3_model = model.model.diffusion_model
    frames = images[..., :3].movedim(-1, 1)
    output = torch.zeros(frame_count, height, width, device=comfy.model_management.intermediate_device())
    keys = sorted(keyframes)

    ranges = []
    if tracking in ("backward", "both"):
        end = keys[0]
        ranges.append((0, end, end, True))
    if tracking in ("forward", "both"):
        for index, start in enumerate(keys):
            end = keys[index + 1] if index + 1 < len(keys) else frame_count - 1
            ranges.append((start, end, start, False))
    elif tracking == "backward":
        for index in range(len(keys) - 1, -1, -1):
            end = keys[index]
            start = keys[index - 1] if index > 0 else 0
            ranges.append((start, end, end, True))

    pbar = comfy.utils.ProgressBar(sum(end - start + 1 for start, end, _, _ in ranges))
    for start, end, seed_frame, reverse in ranges:
        segment = frames[start:end + 1]
        if reverse:
            segment = segment.flip(0)
        initial_mask = keyframes[seed_frame].unsqueeze(0).unsqueeze(0).to(device=device, dtype=dtype)
        result = sam3_model.forward_video(
            images=segment,
            initial_masks=initial_mask,
            pbar=pbar,
            target_device=device,
            target_dtype=dtype,
        )
        tracked = _tracked_masks(result, end - start + 1, height, width)
        if reverse:
            tracked = tracked.flip(0)
        output[start:end + 1] = tracked

    for frame, mask in keyframes.items():
        output[frame] = mask.to(output.device)
    return output


def _save_preview(images, frame_rate, prefix, audio=None):
    filename = f"{prefix}_{uuid.uuid4().hex[:8]}.mp4"
    path = os.path.join(folder_paths.get_temp_directory(), filename)
    preview = InputImpl.VideoFromComponents(Types.VideoComponents(images=images, audio=audio, frame_rate=frame_rate))
    preview.save_to(path, format=Types.VideoContainer.MP4, codec=Types.VideoCodec.H264)
    return ui.SavedResult(filename, "", io.FolderType.temp)


def _resolve_timeline_window(frame_count, selection_start, selection_end, context_before, context_after):
    if frame_count < 1:
        raise ValueError("The source video has no decodable frames")
    selection_start = max(0, min(int(selection_start), frame_count - 1))
    selection_end = max(selection_start + 1, min(int(selection_end), frame_count))
    max_length = (frame_count - 1) // 8 * 8 + 1
    if selection_end - selection_start > max_length:
        raise ValueError("The selected range is too long for LTXV's 8n+1 frame layout")

    requested_start = max(0, selection_start - max(0, int(context_before)))
    requested_end = min(frame_count, selection_end + max(0, int(context_after)))
    requested_length = requested_end - requested_start
    window_length = min(max_length, ((requested_length - 1 + 7) // 8) * 8 + 1)

    earliest_start = max(0, selection_end - window_length)
    latest_start = min(selection_start, frame_count - window_length)
    window_start = min(max(requested_start, earliest_start), latest_start)
    return window_start, window_start + window_length, selection_start, selection_end


def _slice_audio(audio, start_frame, end_frame, frame_rate):
    if audio is None:
        return None
    sample_rate = int(audio["sample_rate"])
    start_sample = round(start_frame / frame_rate * sample_rate)
    end_sample = round(end_frame / frame_rate * sample_rate)
    result = audio.copy()
    result["waveform"] = audio["waveform"][..., start_sample:end_sample].clone()
    return result


def _waveform_preview(audio, bucket_count=1000):
    if audio is None or audio["waveform"].shape[-1] == 0:
        return []
    waveform = audio["waveform"][0].mean(dim=0).abs().float()
    bucket_count = min(bucket_count, waveform.shape[-1])
    peaks = F.adaptive_max_pool1d(waveform.reshape(1, 1, -1), bucket_count).flatten()
    peak = peaks.max()
    if peak > 0:
        peaks = peaks / peak
    return peaks.cpu().tolist()


def _timeline_settings(timeline_data, frame_count, frame_rate):
    data = json.loads(timeline_data) if timeline_data else {}
    max_length = (frame_count - 1) // 8 * 8 + 1
    default_end = min(frame_count, max_length, max(1, round(frame_rate)))
    selection_start = data.get("selection_start", 0)
    selection_end = data.get("selection_end", default_end)
    context_before = data.get("context_before", 2.0)
    context_after = data.get("context_after", 2.0)
    window = _resolve_timeline_window(
        frame_count,
        selection_start,
        selection_end,
        round(max(0.0, float(context_before)) * frame_rate),
        round(max(0.0, float(context_after)) * frame_rate),
    )
    return data, window, float(context_before), float(context_after)


class VideoTimeline(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="VideoTimeline",
            display_name="Video Timeline",
            category="video",
            description="Select a video range for regeneration or paint a frame-by-frame inpainting mask. Outputs an LTX-ready 8n+1 frame window with surrounding context.",
            search_aliases=["video edit timeline", "regenerate video section", "paint video mask"],
            has_intermediate_output=True,
            is_output_node=True,
            inputs=[
                io.Video.Input("video"),
                io.String.Input("timeline_data", default="", socketless=True, extra_dict={"hidden": True}),
            ],
            outputs=[
                io.Image.Output("source"),
                io.Image.Output("guide"),
                io.Mask.Output("mask"),
                io.Audio.Output("audio"),
                io.Int.Output("start_frame"),
                io.Float.Output("fps"),
            ],
        )

    @classmethod
    def execute(cls, video: Input.Video, timeline_data) -> io.NodeOutput:
        components = video.get_components()
        images = components.images
        frame_count, height, width, _ = images.shape
        frame_rate = float(components.frame_rate)
        data, window, context_before, context_after = _timeline_settings(timeline_data, frame_count, frame_rate)
        window_start, window_end, selection_start, selection_end = window
        source = images[window_start:window_end].clone()

        mask = torch.zeros(
            window_end - window_start,
            height,
            width,
            dtype=torch.float32,
            device=source.device,
        )
        mode = data.get("mode", "regenerate")
        if mode == "regenerate":
            mask[selection_start - window_start:selection_end - window_start] = 1.0
        elif mode == "inpaint":
            keyframes = _load_keyframes(json.dumps(data.get("mask", {})), frame_count, height, width)
            for frame, frame_mask in keyframes.items():
                if selection_start <= frame < selection_end:
                    mask[frame - window_start] = frame_mask.to(mask.device)
        else:
            raise ValueError(f"Unknown video timeline mode: {mode}")

        color = torch.tensor(_INPAINT_COLOR, dtype=source.dtype, device=source.device)
        guide = source * (1.0 - mask.unsqueeze(-1)) + color.view(1, 1, 1, 3) * mask.unsqueeze(-1)
        audio = _slice_audio(components.audio, window_start, window_end, frame_rate)

        preview = _save_preview(images, components.frame_rate, "video_timeline", components.audio)
        editor_data = {
            "video": preview,
            "frame_count": frame_count,
            "fps": frame_rate,
            "width": width,
            "height": height,
            "has_audio": components.audio is not None,
            "waveform": _waveform_preview(components.audio),
            "mode": mode,
            "selection_start": selection_start,
            "selection_end": selection_end,
            "context_before": context_before,
            "context_after": context_after,
            "window_start": window_start,
            "window_end": window_end,
        }
        return io.NodeOutput(source, guide, mask, audio, window_start, frame_rate, ui={"video_timeline": [editor_data]})


class VideoTimelineApply(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="VideoTimelineApply",
            display_name="Apply Video Timeline Edit",
            category="video",
            description="Blends an edited frame window back into the source video while preserving its original audio track.",
            inputs=[
                io.Video.Input("video"),
                io.Image.Input("edited_images"),
                io.Mask.Input("mask"),
                io.Int.Input("start_frame", default=0, min=0),
                io.Int.Input("feather", default=8, min=0, max=64),
            ],
            outputs=[io.Video.Output("video")],
        )

    @classmethod
    def execute(cls, video: Input.Video, edited_images, mask, start_frame, feather) -> io.NodeOutput:
        components = video.get_components()
        images = components.images
        frame_count = edited_images.shape[0]
        if mask.shape[0] != frame_count:
            raise ValueError("Edited images and timeline mask must have the same frame count")
        if start_frame + frame_count > images.shape[0]:
            raise ValueError("The edited timeline range exceeds the source video")

        height, width = images.shape[1:3]
        if edited_images.shape[1:3] != (height, width):
            edited_images = comfy.utils.common_upscale(
                edited_images.movedim(-1, 1), width, height, "lanczos", "center"
            ).movedim(1, -1)
        if mask.shape[1:3] != (height, width):
            mask = F.interpolate(mask.unsqueeze(1), size=(height, width), mode="bilinear", align_corners=False)[:, 0]

        mask = mask.to(device=images.device, dtype=images.dtype)
        if feather > 0:
            kernel_size = feather * 2 + 1
            sigma = max(1.0, feather / 2)
            mask = kornia.filters.gaussian_blur2d(
                mask.unsqueeze(1), (kernel_size, kernel_size), (sigma, sigma), border_type="replicate"
            )[:, 0]
        edited_images = edited_images.to(device=images.device, dtype=images.dtype)
        alpha = mask.unsqueeze(-1)
        result = images.clone()
        source = result[start_frame:start_frame + frame_count]
        source.mul_(1.0 - alpha).addcmul_(edited_images, alpha)

        output = InputImpl.VideoFromComponents(
            Types.VideoComponents(images=result, audio=components.audio, frame_rate=components.frame_rate),
            bit_depth=video.get_bit_depth(),
        )
        return io.NodeOutput(output)


class VideoMaskEditor(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="VideoMaskEditor",
            display_name="Video Mask Editor",
            category="video",
            search_aliases=["draw video mask", "track mask", "rotoscope"],
            has_intermediate_output=True,
            inputs=[
                io.Video.Input("video"),
                io.Model.Input("model", optional=True, tooltip="Optional SAM3 or SAM3.1 diffusion model for mask tracking."),
                io.Combo.Input(
                    "tracking",
                    options=["none", "forward", "backward", "both"],
                    default="none",
                    tooltip="Propagate painted keyframes with the connected SAM3 model.",
                ),
                io.String.Input(
                    "mask_data",
                    default="",
                    socketless=True,
                    extra_dict={"hidden": True},
                ),
            ],
            outputs=[io.Mask.Output("mask")],
        )

    @classmethod
    def execute(cls, video: Input.Video, tracking, mask_data, model=None) -> io.NodeOutput:
        components = video.get_components()
        images = components.images
        frame_count, height, width, _ = images.shape
        keyframes = _load_keyframes(mask_data, frame_count, height, width)

        mask = torch.zeros(frame_count, height, width, device=comfy.model_management.intermediate_device())
        for frame, frame_mask in keyframes.items():
            mask[frame] = frame_mask.to(mask.device)

        if tracking != "none" and keyframes:
            if model is None:
                raise ValueError("Connect a SAM3 model to track painted masks")
            comfy.model_management.load_model_gpu(model)
            mask = _track_video(images, keyframes, model, tracking)

        video_preview = _save_preview(images, components.frame_rate, "video_mask_editor")
        mask_preview = None
        if keyframes or tracking != "none":
            mask_images = mask.unsqueeze(-1).expand(-1, -1, -1, 3)
            mask_preview = _save_preview(mask_images, components.frame_rate, "video_mask_editor_mask")

        editor_data = {
            "video": video_preview,
            "mask": mask_preview,
            "frame_count": frame_count,
            "fps": float(components.frame_rate),
            "width": width,
            "height": height,
        }
        return io.NodeOutput(mask, ui={"video_mask_editor": [editor_data]})


class VideoMaskEditorExtension(ComfyExtension):
    @override
    async def get_node_list(self):
        return [VideoMaskEditor, VideoTimeline, VideoTimelineApply]


async def comfy_entrypoint():
    return VideoMaskEditorExtension()
