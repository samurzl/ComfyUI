import json
from fractions import Fraction

import numpy as np
import pytest
import torch
from PIL import Image

from comfy_api.latest import InputImpl, Types
from comfy_extras.nodes_video_mask_editor import (
    VideoTimelineApply,
    _load_keyframes,
    _resolve_timeline_window,
    _slice_audio,
    _track_video,
)


class _FakeDiffusionModel:
    def forward_video(self, images, initial_masks, **kwargs):
        return initial_masks.unsqueeze(0).expand(images.shape[0], -1, -1, -1, -1)[:, :, 0]


class _FakeModel:
    class Model:
        diffusion_model = _FakeDiffusionModel()

        @staticmethod
        def get_dtype():
            return torch.float32

    model = Model()


def _mask(x, y):
    mask = torch.zeros(8, 8)
    mask[y:y + 2, x:x + 2] = 1
    return mask


def test_load_keyframes_from_atlas(tmp_path, monkeypatch):
    atlas = np.zeros((8, 16, 4), dtype=np.uint8)
    atlas[1:3, 2:5, 3] = 255
    atlas[4:7, 10:14, 3] = 255
    atlas_path = tmp_path / "masks.png"
    Image.fromarray(atlas, "RGBA").save(atlas_path)
    monkeypatch.setattr("folder_paths.get_annotated_filepath", lambda _: atlas_path)

    data = json.dumps({"file": "masks.png", "frames": [1, 4], "columns": 2, "width": 8, "height": 8})
    masks = _load_keyframes(data, frame_count=5, height=8, width=8)

    assert sorted(masks) == [1, 4]
    assert masks[1].sum() == 6
    assert masks[4].sum() == 12


def test_track_forward_uses_later_keyframes_as_corrections():
    images = torch.zeros(5, 8, 8, 3)
    first = _mask(1, 1)
    second = _mask(5, 5)

    output = _track_video(images, {1: first, 3: second}, _FakeModel(), "forward")

    assert not output[0].any()
    assert torch.equal(output[1], first)
    assert torch.equal(output[2], first)
    assert torch.equal(output[3], second)
    assert torch.equal(output[4], second)


def test_track_backward_starts_from_an_arbitrary_frame():
    images = torch.zeros(5, 8, 8, 3)
    keyframe = _mask(3, 2)

    output = _track_video(images, {3: keyframe}, _FakeModel(), "backward")

    assert all(torch.equal(output[index], keyframe) for index in range(4))
    assert not output[4].any()


def test_timeline_window_contains_selection_and_uses_ltx_frame_count():
    start, end, selection_start, selection_end = _resolve_timeline_window(100, 30, 40, 20, 20)

    assert start <= selection_start < selection_end <= end
    assert (end - start - 1) % 8 == 0
    assert end - start == 57


def test_timeline_window_clamps_context_at_end():
    start, end, _, _ = _resolve_timeline_window(100, 95, 99, 20, 20)

    assert (start, end) == (75, 100)


def test_timeline_window_rejects_selection_larger_than_valid_ltx_window():
    with pytest.raises(ValueError, match="too long"):
        _resolve_timeline_window(100, 0, 100, 0, 0)


def test_slice_audio_uses_video_frame_boundaries():
    audio = {"waveform": torch.arange(200).reshape(1, 1, 200), "sample_rate": 100}

    result = _slice_audio(audio, 10, 30, 25)

    assert torch.equal(result["waveform"], audio["waveform"][..., 40:120])


def test_apply_timeline_edit_preserves_original_audio():
    images = torch.zeros(10, 8, 8, 3)
    audio = {"waveform": torch.randn(1, 2, 1600), "sample_rate": 16000}
    video = InputImpl.VideoFromComponents(Types.VideoComponents(images=images, audio=audio, frame_rate=Fraction(25)))
    edited = torch.ones(3, 8, 8, 3)
    mask = torch.ones(3, 8, 8)

    output = VideoTimelineApply.execute(video, edited, mask, start_frame=4, feather=0).result[0]
    components = output.get_components()

    assert not components.images[:4].any()
    assert components.images[4:7].all()
    assert not components.images[7:].any()
    assert torch.equal(components.audio["waveform"], audio["waveform"])
