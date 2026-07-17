import json
import os
import uuid
from fractions import Fraction

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
    requested_start = max(0, selection_start - max(0, int(context_before)))
    requested_end = min(frame_count, selection_end + max(0, int(context_after)))
    requested_length = requested_end - requested_start
    window_length = ((requested_length - 1 + 7) // 8) * 8 + 1

    earliest_start = max(0, selection_end - window_length)
    latest_start = min(selection_start, max(0, frame_count - window_length))
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


def _resize_mask(mask, height, width):
    if mask.shape[1:3] == (height, width):
        return mask
    return F.interpolate(mask.unsqueeze(1), size=(height, width), mode="bilinear", align_corners=False)[:, 0]


def _prepare_timeline_images(images, source_frame_rate, output_frame_rate, width=0, height=0, start_frame=0, frame_count=None):
    target_frame_count = images.shape[0]
    if source_frame_rate != output_frame_rate:
        source_rate = float(source_frame_rate)
        target_rate = float(output_frame_rate)
        target_frame_count = max(1, round(images.shape[0] * target_rate / source_rate))
        end_frame = target_frame_count if frame_count is None else min(target_frame_count, start_frame + frame_count)
        indices = [min(images.shape[0] - 1, int(frame * source_rate / target_rate + 1e-6)) for frame in range(start_frame, end_frame)]
        images = images[indices]
    else:
        end_frame = target_frame_count if frame_count is None else min(target_frame_count, start_frame + frame_count)
        images = images[start_frame:end_frame]

    source_height, source_width = images.shape[1:3]
    if width <= 0 and height > 0:
        width = max(1, round(source_width * height / source_height))
    elif height <= 0 and width > 0:
        height = max(1, round(source_height * width / source_width))
    if width > 0 and height > 0 and (source_width, source_height) != (width, height):
        images = comfy.utils.common_upscale(images.movedim(-1, 1), width, height, "lanczos", "disabled").movedim(1, -1)
    return images


def _pyramid_blend_chunk(image_a, image_b, mask, levels):
    gaussian_a = [image_a]
    gaussian_b = [image_b]
    gaussian_mask = [mask]
    for _ in range(levels):
        height, width = gaussian_a[-1].shape[-2:]
        if min(height, width) < 4:
            break
        size = ((height + 1) // 2, (width + 1) // 2)
        gaussian_a.append(F.interpolate(kornia.filters.gaussian_blur2d(gaussian_a[-1], (5, 5), (1.0, 1.0)), size=size, mode="bilinear", align_corners=False))
        gaussian_b.append(F.interpolate(kornia.filters.gaussian_blur2d(gaussian_b[-1], (5, 5), (1.0, 1.0)), size=size, mode="bilinear", align_corners=False))
        gaussian_mask.append(F.interpolate(kornia.filters.gaussian_blur2d(gaussian_mask[-1], (5, 5), (1.0, 1.0), border_type="replicate"), size=size, mode="bilinear", align_corners=False))

    output = gaussian_a[-1] * gaussian_mask[-1] + gaussian_b[-1] * (1.0 - gaussian_mask[-1])
    for level in range(len(gaussian_a) - 2, -1, -1):
        size = gaussian_a[level].shape[-2:]
        laplacian_a = gaussian_a[level] - F.interpolate(gaussian_a[level + 1], size=size, mode="bilinear", align_corners=False)
        laplacian_b = gaussian_b[level] - F.interpolate(gaussian_b[level + 1], size=size, mode="bilinear", align_corners=False)
        output = F.interpolate(output, size=size, mode="bilinear", align_corners=False)
        output += laplacian_a * gaussian_mask[level] + laplacian_b * (1.0 - gaussian_mask[level])
    return output.clamp(0, 1)


def _timeline_settings(timeline_data, frame_count, frame_rate):
    data = json.loads(timeline_data) if timeline_data else {}
    default_end = min(frame_count, max(1, round(frame_rate)))
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


class VideoProjectFormat(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="VideoProjectFormat",
            display_name="Conform Video to Project",
            category="video",
            inputs=[
                io.Video.Input("video"),
                io.Float.Input("frame_rate", default=24.0, min=1.0, max=240.0),
                io.Int.Input("width", default=1920, min=1, max=16384),
                io.Int.Input("height", default=1080, min=1, max=16384),
                io.Float.Input("start_time", default=0.0, min=0.0, max=1e5),
                io.Float.Input("duration", default=0.0, min=0.0, max=1e5),
            ],
            outputs=[io.Video.Output("video")],
        )

    @classmethod
    def execute(cls, video: Input.Video, frame_rate, width, height, start_time=0.0, duration=0.0) -> io.NodeOutput:
        components = video.get_components()
        output_frame_rate = Fraction(str(frame_rate))
        converted_frame_count = max(1, round(components.images.shape[0] * float(output_frame_rate) / float(components.frame_rate)))
        start_frame = min(converted_frame_count - 1, max(0, round(start_time * frame_rate)))
        frame_count = converted_frame_count - start_frame if duration <= 0 else min(converted_frame_count - start_frame, max(1, round(duration * frame_rate)))
        end_frame = start_frame + frame_count
        images = _prepare_timeline_images(
            components.images,
            components.frame_rate,
            output_frame_rate,
            width,
            height,
            start_frame,
            frame_count,
        )
        audio = _slice_audio(components.audio, start_frame, end_frame, frame_rate)
        output = InputImpl.VideoFromComponents(
            Types.VideoComponents(images=images, audio=audio, frame_rate=output_frame_rate),
            bit_depth=video.get_bit_depth(),
        )
        return io.NodeOutput(output)


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
                io.Float.Input("frame_rate", default=0.0, min=0.0, max=240.0, tooltip="Output frame rate, or 0 to preserve the source frame rate."),
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
    def execute(cls, video: Input.Video, timeline_data, frame_rate=0.0) -> io.NodeOutput:
        components = video.get_components()
        images = components.images
        frame_count, height, width, _ = images.shape
        output_frame_rate = Fraction(str(frame_rate)) if frame_rate > 0 else components.frame_rate
        data, window, context_before, context_after = _timeline_settings(timeline_data, frame_count, float(output_frame_rate))
        window_start, window_end, selection_start, selection_end = window
        source = images[window_start:min(window_end, frame_count)].clone()
        if window_end > frame_count:
            source = torch.cat((source, source[-1:].expand(window_end - frame_count, -1, -1, -1)))

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
            if window_end > frame_count and selection_end == frame_count:
                mask[frame_count - window_start:] = mask[frame_count - window_start - 1]
        else:
            raise ValueError(f"Unknown video timeline mode: {mode}")

        color = torch.tensor(_INPAINT_COLOR, dtype=source.dtype, device=source.device)
        guide = source * (1.0 - mask.unsqueeze(-1)) + color.view(1, 1, 1, 3) * mask.unsqueeze(-1)
        audio = _slice_audio(components.audio, window_start, window_end, float(output_frame_rate))

        preview = _save_preview(images, output_frame_rate, "video_timeline", components.audio)
        editor_data = {
            "video": preview,
            "frame_count": frame_count,
            "fps": float(output_frame_rate),
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
        return io.NodeOutput(source, guide, mask, audio, window_start, float(output_frame_rate), ui={"video_timeline": [editor_data]})


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
                io.Float.Input("frame_rate", default=0.0, min=0.0, max=240.0, tooltip="Output frame rate, or 0 to preserve the source frame rate."),
                io.Boolean.Input("composited", default=False, tooltip="Replace the complete edited window when it has already been blended with the source."),
            ],
            outputs=[io.Video.Output("video")],
        )

    @classmethod
    def execute(cls, video: Input.Video, edited_images, mask, start_frame, feather, frame_rate=0.0, composited=False) -> io.NodeOutput:
        components = video.get_components()
        images = components.images
        output_frame_rate = Fraction(str(frame_rate)) if frame_rate > 0 else components.frame_rate
        frame_count = edited_images.shape[0]
        if mask.shape[0] != frame_count:
            raise ValueError("Edited images and timeline mask must have the same frame count")
        available_frames = images.shape[0] - start_frame
        if available_frames < 1:
            raise ValueError("The edited timeline range exceeds the source video")
        if frame_count > available_frames:
            frame_count = available_frames
            edited_images = edited_images[:frame_count]
            mask = mask[:frame_count]

        height, width = images.shape[1:3]
        if edited_images.shape[1:3] != (height, width):
            edited_images = comfy.utils.common_upscale(
                edited_images.movedim(-1, 1), width, height, "lanczos", "center"
            ).movedim(1, -1)
        edited_images = edited_images.to(device=images.device, dtype=images.dtype)
        result = images.clone()
        source = result[start_frame:start_frame + frame_count]
        if composited:
            source.copy_(edited_images)
        else:
            if mask.shape[1:3] != (height, width):
                mask = F.interpolate(mask.unsqueeze(1), size=(height, width), mode="bilinear", align_corners=False)[:, 0]
            mask = (mask.to(device=images.device) >= 0.5).to(dtype=images.dtype)
            if feather > 0:
                kernel_size = feather * 2 + 1
                sigma = max(1.0, feather / 2)
                mask = F.max_pool2d(mask.unsqueeze(1), kernel_size, stride=1, padding=feather)[:, 0]
                mask = kornia.filters.gaussian_blur2d(
                    mask.unsqueeze(1), (kernel_size, kernel_size), (sigma, sigma), border_type="replicate"
                )[:, 0]
            alpha = mask.unsqueeze(-1)
            source.mul_(1.0 - alpha).addcmul_(edited_images, alpha)

        output = InputImpl.VideoFromComponents(
            Types.VideoComponents(images=result, audio=components.audio, frame_rate=output_frame_rate),
            bit_depth=video.get_bit_depth(),
        )
        return io.NodeOutput(output)


class VideoInpaintPreprocess(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="VideoInpaintPreprocess",
            display_name="Prepare Video Inpaint Guide",
            category="video",
            inputs=[io.Image.Input("images"), io.Mask.Input("mask")],
            outputs=[io.Image.Output("images")],
        )

    @classmethod
    def execute(cls, images, mask) -> io.NodeOutput:
        frame_count = min(images.shape[0], mask.shape[0])
        images = images[:frame_count]
        mask = _resize_mask(mask[:frame_count], images.shape[1], images.shape[2]).to(device=images.device, dtype=images.dtype)
        color = torch.tensor(_INPAINT_COLOR, dtype=images.dtype, device=images.device)
        alpha = mask.unsqueeze(-1)
        return io.NodeOutput(images * (1.0 - alpha) + color.view(1, 1, 1, 3) * alpha)


class VideoInpaintPyramidBlend(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="VideoInpaintPyramidBlend",
            display_name="Blend Video Inpaint Boundary",
            category="video",
            inputs=[
                io.Image.Input("generated"),
                io.Image.Input("source"),
                io.Mask.Input("mask"),
                io.Int.Input("grow", default=0, min=0, max=64),
                io.Int.Input("levels", default=5, min=1, max=8),
            ],
            outputs=[io.Image.Output("images")],
        )

    @classmethod
    def execute(cls, generated, source, mask, grow, levels) -> io.NodeOutput:
        frame_count = min(generated.shape[0], source.shape[0], mask.shape[0])
        generated = generated[:frame_count]
        source = source[:frame_count]
        height, width = generated.shape[1:3]
        if source.shape[1:3] != (height, width):
            source = comfy.utils.common_upscale(source.movedim(-1, 1), width, height, "lanczos", "center").movedim(1, -1)
        mask = _resize_mask(mask[:frame_count], height, width)
        core_mask = (mask >= 0.5).to(mask.dtype)
        if grow > 0:
            mask = F.max_pool2d(mask.unsqueeze(1), grow * 2 + 1, stride=1, padding=grow)[:, 0]

        device = comfy.model_management.get_torch_device()
        output_device = comfy.model_management.intermediate_device()
        results = []
        for start in range(0, frame_count, 8):
            end = min(start + 8, frame_count)
            image_a = generated[start:end].movedim(-1, 1).to(device)
            image_b = source[start:end].movedim(-1, 1).to(device=device, dtype=image_a.dtype)
            blend_mask = mask[start:end].unsqueeze(1).to(device=device, dtype=image_a.dtype)
            core = core_mask[start:end].unsqueeze(1).to(device=device, dtype=image_a.dtype)
            blended = _pyramid_blend_chunk(image_a, image_b, blend_mask, levels)
            results.append((image_a * core + blended * (1.0 - core)).movedim(1, -1).to(output_device))
        return io.NodeOutput(torch.cat(results))


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
        return [VideoMaskEditor, VideoProjectFormat, VideoTimeline, VideoTimelineApply, VideoInpaintPreprocess, VideoInpaintPyramidBlend]


async def comfy_entrypoint():
    return VideoMaskEditorExtension()
