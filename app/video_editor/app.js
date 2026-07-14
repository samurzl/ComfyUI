const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const uid = (prefix) => `${prefix}-${crypto.randomUUID()}`;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const roundFrame = (seconds) => Math.round(seconds * state.project.fps) / state.project.fps;
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "mkv", "avi"]);

const defaultSettings = {
    samCheckpoint: "sam3.1_multiplex_fp16.safetensors",
    ltxCheckpoint: "ltx-2.3-22b-dev-fp8.safetensors",
    ltxDistilledLora: "ltx-2.3-22b-distilled-lora-384.safetensors",
    ltxInpaintLora: "ltx-2.3-22b-ic-lora-in-outpainting-0.9.safetensors",
    ltxTextEncoder: "gemma_3_12B_it_fp4_mixed.safetensors",
    ltxSpatialUpscaler: "ltx-2.3-spatial-upscaler-x2-1.1.safetensors",
    kreaDiffusionModel: "",
    kreaTextEncoder: "",
    kreaVae: "",
    kreaEditLora: "",
    kreaGroundingPx: 768,
    editAnythingMode: "reference-visual",
    editAnythingStandardLora: "",
    editAnythingModuleLora: "",
    loraLibrary: [],
    projectWidth: 1920,
    projectHeight: 1080,
    projectFps: 30,
    imageEditWorkflow: "",
    refEditWorkflow: "",
};

const state = {
    project: {
        name: "Untitled sequence",
        width: 1920,
        height: 1080,
        fps: 30,
        tracks: [
            { id: uid("track"), kind: "video", name: "Video 1", enabled: true, clips: [] },
            { id: uid("track"), kind: "audio", name: "Audio 1", enabled: true, clips: [] },
        ],
        media: [],
    },
    settings: { ...defaultSettings, ...readSettings() },
    backend: { online: false, models: {}, nodeTypes: new Set(), socket: null, jobs: new Map() },
    selectedClipId: null,
    tool: "select",
    linkMode: true,
    playhead: 0,
    playing: false,
    playStartedAt: 0,
    playStartedFrom: 0,
    pixelsPerSecond: 90,
    previewZoom: null,
    clipboard: null,
    undo: [],
    redo: [],
    runtime: new Map(),
    files: new Map(),
    activeModal: null,
};

state.project.width = Number(state.settings.projectWidth) || 1920;
state.project.height = Number(state.settings.projectHeight) || 1080;
state.project.fps = Number(state.settings.projectFps) || 30;

const previewCanvas = $("#preview-canvas");
const previewContext = previewCanvas.getContext("2d");
const runtimeRoot = $("#media-runtime");

function readSettings() {
    try {
        const settings = JSON.parse(localStorage.getItem("comfy-cut-settings") || "{}");
        settings.loraLibrary = Array.isArray(settings.loraLibrary) ? settings.loraLibrary : [];
        delete settings.kreaCheckpoint;
        delete settings.editAnythingLora;
        return settings;
    } catch {
        return {};
    }
}

function saveSettings() {
    localStorage.setItem("comfy-cut-settings", JSON.stringify(state.settings));
}

function snapshot() {
    return JSON.stringify({ project: state.project, selectedClipId: state.selectedClipId, playhead: state.playhead }, (key, value) => key === "file" ? undefined : value);
}

function checkpoint(value = snapshot()) {
    state.undo.push(value);
    if (state.undo.length > 50) state.undo.shift();
    state.redo.length = 0;
    updateUndoButtons();
}

function restore(value) {
    const restored = JSON.parse(value);
    state.project = restored.project;
    for (const media of state.project.media) media.file = state.files.get(media.id) || null;
    state.selectedClipId = restored.selectedClipId;
    state.playhead = restored.playhead;
    disposeOrphanRuntime();
    renderAll();
}

function undo() {
    if (!state.undo.length) return;
    state.redo.push(snapshot());
    restore(state.undo.pop());
    updateUndoButtons();
}

function redo() {
    if (!state.redo.length) return;
    state.undo.push(snapshot());
    restore(state.redo.pop());
    updateUndoButtons();
}

function updateUndoButtons() {
    $("#undo-button").disabled = !state.undo.length;
    $("#redo-button").disabled = !state.redo.length;
}

function findTrack(trackId) {
    return state.project.tracks.find((track) => track.id === trackId);
}

function findClip(clipId) {
    for (const track of state.project.tracks) {
        const clip = track.clips.find((candidate) => candidate.id === clipId);
        if (clip) return { clip, track };
    }
    return null;
}

function findMedia(mediaId) {
    return state.project.media.find((media) => media.id === mediaId);
}

function selected() {
    return state.selectedClipId ? findClip(state.selectedClipId) : null;
}

function projectDuration() {
    return Math.max(10, ...state.project.tracks.flatMap((track) => track.clips.map((clip) => clip.start + clip.duration)));
}

function sequenceDuration() {
    return Math.max(0, ...state.project.tracks.filter((track) => track.enabled).flatMap((track) => track.clips.map((clip) => clip.start + clip.duration)));
}

function formatClock(seconds, includeFrames = false) {
    seconds = Math.max(0, seconds || 0);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds / 60) % 60;
    const secs = Math.floor(seconds) % 60;
    const frames = Math.floor((seconds % 1) * state.project.fps);
    const parts = [hours, minutes, secs].map((part) => String(part).padStart(2, "0"));
    return includeFrames ? `${parts.join(":")}:${String(frames).padStart(2, "0")}` : `${parts[1]}:${parts[2]}`;
}

function toast(title, detail = "", type = "") {
    const element = document.createElement("div");
    element.className = `toast ${type}`;
    element.innerHTML = `<strong>${escapeHtml(title)}</strong>${detail ? `<span>${escapeHtml(detail)}</span>` : ""}`;
    $("#toast-stack").append(element);
    setTimeout(() => element.remove(), 4200);
}

function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function renderAll() {
    renderMediaBin();
    renderTimeline();
    renderInspector();
    updateAIButtons();
    updateViewerLabels();
    drawPreview();
}

function updateViewerLabels() {
    $("#sequence-title").textContent = state.project.name;
    $("#viewer-resolution").textContent = `${state.project.width} × ${state.project.height} · ${state.project.fps} fps`;
    $("#timeline-duration").textContent = formatClock(projectDuration());
    $("#timecode").textContent = formatClock(state.playhead, true);
    $("#viewer-empty").hidden = state.project.media.length > 0;
}

function renderMediaBin() {
    const bin = $("#media-bin");
    if (!state.project.media.length) {
        bin.innerHTML = '<button class="empty-media" id="empty-import"><span>＋</span><strong>Import your first video</strong><small>MP4, MOV, WebM, and more</small></button>';
        $("#empty-import").onclick = chooseVideo;
        return;
    }
    bin.innerHTML = "";
    for (const media of state.project.media) {
        const card = document.createElement("div");
        card.className = "media-card";
        card.draggable = true;
        card.dataset.mediaId = media.id;
        card.innerHTML = `<video src="${escapeHtml(media.url)}" muted preload="metadata"></video><div><strong>${escapeHtml(media.name)}</strong><span>${formatClock(media.duration)} · ${media.width}×${media.height}</span></div>`;
        card.ondragstart = (event) => event.dataTransfer.setData("application/x-comfy-cut-media", media.id);
        card.ondblclick = () => insertMedia(media.id, state.playhead);
        bin.append(card);
    }
}

function renderTimeline() {
    const duration = projectDuration();
    const contentWidth = Math.max(900, Math.ceil(duration * state.pixelsPerSecond) + 120);
    const surface = $("#timeline-surface");
    surface.style.width = `${contentWidth + 156}px`;
    renderRuler(duration);
    const tracks = $("#tracks");
    tracks.innerHTML = "";
    for (const track of state.project.tracks) tracks.append(renderTrack(track));
    surface.style.height = `${28 + state.project.tracks.reduce((sum, track) => sum + (track.kind === "audio" ? 58 : 70), 0)}px`;
    updatePlayhead();
}

function renderRuler(duration) {
    const ruler = $("#ruler");
    ruler.innerHTML = "";
    const minor = state.pixelsPerSecond >= 140 ? 0.25 : state.pixelsPerSecond >= 70 ? 0.5 : 1;
    const major = state.pixelsPerSecond >= 140 ? 1 : state.pixelsPerSecond >= 70 ? 2 : 5;
    for (let time = 0; time <= duration + 2; time += minor) {
        const mark = document.createElement("i");
        const isMajor = Math.abs(time / major - Math.round(time / major)) < 0.001;
        mark.className = `ruler-mark${isMajor ? " major" : ""}`;
        mark.style.left = `${time * state.pixelsPerSecond}px`;
        if (isMajor) mark.innerHTML = `<span>${formatClock(time)}</span>`;
        ruler.append(mark);
    }
}

function renderTrack(track) {
    const row = document.createElement("div");
    row.className = `track-row ${track.kind}`;
    row.dataset.trackId = track.id;
    row.innerHTML = `<div class="track-head"><span class="track-badge">${track.kind === "video" ? "V" : "A"}</span><div><strong>${escapeHtml(track.name)}</strong><span>${track.kind === "video" ? "Video track" : "Audio track"}</span></div><button class="track-toggle ${track.enabled ? "active" : ""}" title="${track.enabled ? "Disable" : "Enable"} track">${track.kind === "video" ? "◉" : "♪"}</button></div><div class="track-content"></div>`;
    $(".track-toggle", row).onclick = () => {
        checkpoint();
        track.enabled = !track.enabled;
        renderAll();
    };
    const content = $(".track-content", row);
    content.ondragover = (event) => {
        if (!event.dataTransfer.types.includes("application/x-comfy-cut-media")) return;
        event.preventDefault();
        row.classList.add("drop-target");
    };
    content.ondragleave = () => row.classList.remove("drop-target");
    content.ondrop = (event) => {
        event.preventDefault();
        row.classList.remove("drop-target");
        const mediaId = event.dataTransfer.getData("application/x-comfy-cut-media");
        if (mediaId && track.kind === "video") insertMedia(mediaId, pointerTime(event, content), track.id);
    };
    content.onpointerdown = (event) => {
        if (event.target !== content) return;
        selectClip(null);
        startTimelineScrub(event);
    };
    for (const clip of track.clips) content.append(renderClip(clip, track));
    return row;
}

function renderClip(clip, track) {
    const media = findMedia(clip.mediaId);
    const element = document.createElement("div");
    element.className = `clip ${track.kind}${clip.generated ? " generated" : ""}${clip.id === state.selectedClipId ? " selected" : ""}${state.tool === "cut" ? " cut-hover" : ""}`;
    element.dataset.clipId = clip.id;
    element.style.left = `${clip.start * state.pixelsPerSecond}px`;
    element.style.width = `${Math.max(5, clip.duration * state.pixelsPerSecond)}px`;
    const strip = track.kind === "video" && media?.poster ? `style="background-image:url('${escapeHtml(media.poster)}')"` : "";
    element.innerHTML = `<div class="clip-content"><span class="clip-name">${escapeHtml(clip.name)}</span><span class="clip-time">${formatClock(clip.duration)}</span></div><div class="clip-strip" ${strip}></div><i class="trim-handle left"></i><i class="trim-handle right"></i>`;
    element.onpointerdown = (event) => startClipPointer(event, clip, track, element);
    return element;
}

function pointerTime(event, content) {
    const rect = content.getBoundingClientRect();
    return roundFrame(Math.max(0, (event.clientX - rect.left) / state.pixelsPerSecond));
}

function timelinePointerTime(event) {
    const rect = $("#ruler").getBoundingClientRect();
    return roundFrame(Math.max(0, (event.clientX - rect.left) / state.pixelsPerSecond));
}

function startTimelineScrub(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const update = (pointerEvent) => setPlayhead(timelinePointerTime(pointerEvent));
    target.setPointerCapture?.(pointerId);
    update(event);
    const move = (moveEvent) => update(moveEvent);
    const up = (upEvent) => {
        if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
        target.removeEventListener("pointermove", move);
        target.removeEventListener("pointerup", up);
        target.removeEventListener("pointercancel", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
}

function startClipPointer(event, clip, track, element) {
    event.stopPropagation();
    selectClip(clip.id, false);
    const rect = element.parentElement.getBoundingClientRect();
    if (state.tool === "cut") {
        splitClip(clip.id, roundFrame((event.clientX - rect.left) / state.pixelsPerSecond));
        return;
    }
    const handle = event.target.closest(".trim-handle");
    const mode = handle?.classList.contains("left") ? "trim-left" : handle?.classList.contains("right") ? "trim-right" : "move";
    const before = snapshot();
    const originX = event.clientX;
    const originStart = clip.start;
    const originDuration = clip.duration;
    const originSourceIn = clip.sourceIn;
    const originMask = structuredClone(clip.mask);
    const originImages = structuredClone(clip.images || []);
    const linked = state.linkMode && clip.linkedId ? findClip(clip.linkedId)?.clip : null;
    const linkedOrigin = linked ? { start: linked.start, duration: linked.duration, sourceIn: linked.sourceIn } : null;
    let targetTrack = track;
    element.setPointerCapture(event.pointerId);

    const move = (moveEvent) => {
        const delta = roundFrame((moveEvent.clientX - originX) / state.pixelsPerSecond);
        if (mode === "move") {
            clip.start = Math.max(0, originStart + delta);
            if (linked) linked.start = Math.max(0, linkedOrigin.start + (clip.start - originStart));
            const row = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest(".track-row");
            const candidate = row ? findTrack(row.dataset.trackId) : null;
            if (candidate?.kind === track.kind) targetTrack = candidate;
            $$(".track-row").forEach((trackRow) => trackRow.classList.toggle("drop-target", trackRow.dataset.trackId === targetTrack.id && targetTrack !== track));
        } else if (mode === "trim-left") {
            const applied = clamp(delta, -originSourceIn, originDuration - 1 / state.project.fps);
            clip.start = originStart + applied;
            clip.sourceIn = originSourceIn + applied;
            clip.duration = originDuration - applied;
            if (linked) {
                linked.start = linkedOrigin.start + applied;
                linked.sourceIn = linkedOrigin.sourceIn + applied;
                linked.duration = linkedOrigin.duration - applied;
            }
        } else {
            clip.duration = clamp(originDuration + delta, 1 / state.project.fps, clip.sourceDuration - originSourceIn);
            if (linked) linked.duration = clip.duration;
        }
        updateClipElement(element, clip);
        if (linked) {
            const linkedElement = $(`.clip[data-clip-id="${CSS.escape(linked.id)}"]`);
            if (linkedElement) updateClipElement(linkedElement, linked);
        }
        renderInspector();
        drawPreview();
    };
    const up = (upEvent) => {
        element.releasePointerCapture(upEvent.pointerId);
        element.removeEventListener("pointermove", move);
        element.removeEventListener("pointerup", up);
        element.removeEventListener("pointercancel", up);
        $$(".track-row").forEach((trackRow) => trackRow.classList.remove("drop-target"));
        if (mode === "move" && targetTrack !== track) {
            track.clips = track.clips.filter((candidate) => candidate.id !== clip.id);
            targetTrack.clips.push(clip);
        }
        if (track.kind === "video" && mode === "trim-left") {
            const offset = clip.sourceIn - originSourceIn;
            clip.mask = sliceMask(originMask, offset, offset + clip.duration);
            clip.images = sliceImages(originImages, offset, offset + clip.duration);
        } else if (track.kind === "video" && mode === "trim-right") {
            clip.mask = sliceMask(originMask, 0, clip.duration);
            clip.images = sliceImages(originImages, 0, clip.duration);
        }
        if (snapshot() !== before) checkpoint(before);
        renderTimeline();
        renderInspector();
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", up);
}

function updateClipElement(element, clip) {
    element.style.left = `${clip.start * state.pixelsPerSecond}px`;
    element.style.width = `${Math.max(5, clip.duration * state.pixelsPerSecond)}px`;
    const duration = $(".clip-time", element);
    if (duration) duration.textContent = formatClock(clip.duration);
}

function selectClip(clipId, render = true) {
    state.selectedClipId = clipId;
    if (render) renderTimeline();
    else $$(".clip").forEach((element) => element.classList.toggle("selected", element.dataset.clipId === clipId));
    renderInspector();
    updateAIButtons();
}

function setPlayhead(time) {
    state.playhead = clamp(roundFrame(time), 0, projectDuration());
    if (state.playing) {
        state.playStartedFrom = state.playhead;
        state.playStartedAt = performance.now();
    }
    updatePlayhead();
    drawPreview();
}

function updatePlayhead() {
    $("#playhead").style.transform = `translateX(${state.playhead * state.pixelsPerSecond}px)`;
    $("#timecode").textContent = formatClock(state.playhead, true);
}

async function importVideo(file) {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.src = url;
    await new Promise((resolve, reject) => {
        video.onloadedmetadata = resolve;
        video.onerror = () => reject(new Error("This browser could not read that video."));
    });
    const poster = await makePoster(video);
    const media = {
        id: uid("media"),
        name: file.name,
        url,
        file,
        duration: video.duration,
        width: video.videoWidth,
        height: video.videoHeight,
        poster,
        uploaded: null,
        generated: false,
    };
    state.files.set(media.id, file);
    checkpoint();
    state.project.media.push(media);
    if (state.project.media.length === 1) {
        state.project.name = file.name.replace(/\.[^.]+$/, "");
        state.project.width = media.width;
        state.project.height = media.height;
        insertMedia(media.id, 0, null, false);
    }
    renderAll();
    toast("Video imported", `${file.name} is ready on the timeline.`);
}

async function makePoster(video) {
    try {
        video.currentTime = Math.min(0.2, video.duration / 2);
        await new Promise((resolve) => video.addEventListener("seeked", resolve, { once: true }));
        const canvas = document.createElement("canvas");
        canvas.width = 240;
        canvas.height = Math.round(240 * video.videoHeight / video.videoWidth);
        canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/jpeg", 0.72);
    } catch {
        return "";
    }
}

function insertMedia(mediaId, start = 0, preferredTrackId = null, createCheckpoint = true) {
    const media = findMedia(mediaId);
    if (!media) return;
    if (createCheckpoint) checkpoint();
    let videoTrack = preferredTrackId ? findTrack(preferredTrackId) : state.project.tracks.find((track) => track.kind === "video");
    if (!videoTrack || videoTrack.kind !== "video") videoTrack = state.project.tracks.find((track) => track.kind === "video");
    let audioTrack = state.project.tracks.find((track) => track.kind === "audio");
    if (!audioTrack) {
        audioTrack = { id: uid("track"), kind: "audio", name: "Audio 1", enabled: true, clips: [] };
        state.project.tracks.push(audioTrack);
    }
    const videoId = uid("clip");
    const audioId = uid("clip");
    const base = { mediaId, name: media.name, start: roundFrame(start), duration: media.duration, sourceIn: 0, sourceDuration: media.duration };
    videoTrack.clips.push({ ...base, id: videoId, linkedId: audioId, transform: defaultTransform(), mask: null, images: [], generated: media.generated });
    audioTrack.clips.push({ ...base, id: audioId, linkedId: videoId, transform: null, mask: null, images: [], generated: media.generated });
    state.selectedClipId = videoId;
    renderAll();
}

function defaultTransform() {
    return { scale: 100, x: 0, y: 0, rotation: 0, opacity: 100 };
}

function chooseVideo() {
    $("#file-input").click();
}

function splitClip(clipId = state.selectedClipId, time = state.playhead) {
    const result = findClip(clipId);
    if (!result) return;
    const { clip, track } = result;
    if (time <= clip.start + 1 / state.project.fps || time >= clip.start + clip.duration - 1 / state.project.fps) {
        toast("Move the playhead inside the clip", "A cut needs room on both sides.");
        return;
    }
    checkpoint();
    const offset = time - clip.start;
    const right = structuredClone(clip);
    right.id = uid("clip");
    right.start = time;
    right.sourceIn += offset;
    right.duration -= offset;
    clip.duration = offset;
    if (track.kind === "video") {
        const mask = structuredClone(clip.mask);
        const images = structuredClone(clip.images || []);
        clip.mask = sliceMask(mask, 0, offset);
        clip.images = sliceImages(images, 0, offset);
        right.mask = sliceMask(mask, offset, offset + right.duration);
        right.images = sliceImages(images, offset, offset + right.duration);
    }
    right.linkedId = null;
    track.clips.push(right);

    if (state.linkMode && clip.linkedId) {
        const linkedResult = findClip(clip.linkedId);
        if (linkedResult) {
            const linked = linkedResult.clip;
            const linkedRight = structuredClone(linked);
            linkedRight.id = uid("clip");
            linkedRight.start = time;
            linkedRight.sourceIn += offset;
            linkedRight.duration -= offset;
            linked.duration = offset;
            clip.linkedId = linked.id;
            linked.linkedId = clip.id;
            right.linkedId = linkedRight.id;
            linkedRight.linkedId = right.id;
            linkedResult.track.clips.push(linkedRight);
        }
    }
    state.selectedClipId = right.id;
    setPlayhead(time);
    renderAll();
}

function sliceMask(mask, start, end) {
    if (!mask) return null;
    const result = structuredClone(mask);
    const sliceLayers = (layers) => (layers || []).flatMap((layer) => {
        const layerStart = Math.max(start, layer.start);
        const layerEnd = Math.min(end, layer.end);
        return layerEnd > layerStart ? [{ ...layer, start: layerStart - start, end: layerEnd - start }] : [];
    });
    result.shapes = sliceLayers(result.shapes);
    result.corrections = sliceLayers(result.corrections);
    if (result.sam) {
        result.sam.offset = (result.sam.offset || 0) + start;
        for (const key of ["positive", "negative"]) result.sam[key] = (result.sam[key] || []).filter((point) => point.time == null || (point.time >= start && point.time < end)).map((point) => ({ ...point, time: point.time == null ? point.time : point.time - start }));
    }
    return result.sam || result.shapes.length || result.corrections.length ? result : null;
}

function sliceImages(images, start, end) {
    return images.filter((image) => image.sourceTime >= start && image.sourceTime < end).map((image) => ({ ...image, sourceTime: image.sourceTime - start }));
}

function deleteSelection() {
    const result = selected();
    if (!result) return;
    checkpoint();
    const ids = new Set([result.clip.id]);
    if (state.linkMode && result.clip.linkedId) ids.add(result.clip.linkedId);
    for (const track of state.project.tracks) track.clips = track.clips.filter((clip) => !ids.has(clip.id));
    state.selectedClipId = null;
    disposeOrphanRuntime();
    renderAll();
}

function copySelection() {
    const result = selected();
    if (!result) return;
    const clips = [{ clip: structuredClone(result.clip), kind: result.track.kind }];
    if (state.linkMode && result.clip.linkedId) {
        const linked = findClip(result.clip.linkedId);
        if (linked) clips.push({ clip: structuredClone(linked.clip), kind: linked.track.kind });
    }
    state.clipboard = clips;
    toast("Copied", clips.length > 1 ? "Linked video and audio copied." : `${result.clip.name} copied.`);
}

function pasteSelection() {
    if (!state.clipboard?.length) return;
    checkpoint();
    const newIds = new Map();
    for (const item of state.clipboard) newIds.set(item.clip.id, uid("clip"));
    let first = null;
    for (const item of state.clipboard) {
        const clip = structuredClone(item.clip);
        const relative = clip.start - state.clipboard[0].clip.start;
        clip.id = newIds.get(item.clip.id);
        clip.linkedId = item.clip.linkedId ? newIds.get(item.clip.linkedId) || null : null;
        clip.start = Math.max(0, state.playhead + relative);
        const track = state.project.tracks.find((candidate) => candidate.kind === item.kind);
        track.clips.push(clip);
        first ||= clip;
    }
    state.selectedClipId = first?.id || null;
    renderAll();
}

function duplicateSelection() {
    const result = selected();
    if (!result) return;
    copySelection();
    const oldPlayhead = state.playhead;
    state.playhead = result.clip.start + result.clip.duration;
    pasteSelection();
    state.playhead = oldPlayhead;
    updatePlayhead();
}

function runtimeElement(clip, kind) {
    let element = state.runtime.get(clip.id);
    const media = findMedia(clip.mediaId);
    if (element && element.dataset.url !== media?.url) {
        element.remove();
        state.runtime.delete(clip.id);
        element = null;
    }
    if (!element && media) {
        element = document.createElement(kind === "audio" ? "audio" : "video");
        element.src = media.url;
        element.preload = "auto";
        element.playsInline = true;
        element.dataset.url = media.url;
        if (kind === "video") element.muted = true;
        if (kind === "video") {
            const refreshPausedPreview = () => {
                if (!state.playing && activeClips("video").some(({ clip: active }) => active.id === clip.id)) drawPreview();
            };
            element.addEventListener("loadeddata", refreshPausedPreview);
            element.addEventListener("seeked", refreshPausedPreview);
        }
        runtimeRoot.append(element);
        state.runtime.set(clip.id, element);
    }
    return element;
}

function disposeOrphanRuntime() {
    const ids = new Set(state.project.tracks.flatMap((track) => track.clips.map((clip) => clip.id)));
    for (const [id, element] of state.runtime) {
        if (ids.has(id)) continue;
        element.pause();
        element.remove();
        state.runtime.delete(id);
    }
}

function activeClips(kind, time = state.playhead) {
    return state.project.tracks
        .filter((track) => track.kind === kind && track.enabled)
        .flatMap((track, index) => track.clips.map((clip) => ({ clip, track, index })))
        .filter(({ clip }) => time >= clip.start && time < clip.start + clip.duration);
}

function syncRuntime() {
    const activeIds = new Set();
    for (const kind of ["video", "audio"]) {
        for (const { clip } of activeClips(kind)) {
            const element = runtimeElement(clip, kind);
            if (!element) continue;
            activeIds.add(clip.id);
            const sourceTime = clip.sourceIn + state.playhead - clip.start;
            if (Math.abs(element.currentTime - sourceTime) > (state.playing ? 0.18 : 0.025)) element.currentTime = clamp(sourceTime, 0, Math.max(0, element.duration || clip.sourceDuration));
            if (kind === "audio") element.muted = false;
            if (state.playing && element.paused) element.play().catch(() => {});
            if (!state.playing && !element.paused) element.pause();
        }
    }
    for (const [id, element] of state.runtime) {
        if (!activeIds.has(id) && !element.paused) element.pause();
    }
}

function drawPreview() {
    if (previewCanvas.width !== state.project.width || previewCanvas.height !== state.project.height) {
        previewCanvas.width = state.project.width;
        previewCanvas.height = state.project.height;
    }
    applyPreviewSize();
    previewContext.fillStyle = "#050505";
    previewContext.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
    syncRuntime();
    const clips = activeClips("video").sort((a, b) => b.index - a.index);
    for (const { clip } of clips) {
        const video = runtimeElement(clip, "video");
        if (!video || video.readyState < 2) continue;
        const transform = clip.transform || defaultTransform();
        const scale = transform.scale / 100;
        const sourceRatio = video.videoWidth / video.videoHeight;
        const targetRatio = previewCanvas.width / previewCanvas.height;
        let width;
        let height;
        if (sourceRatio > targetRatio) {
            width = previewCanvas.width * scale;
            height = width / sourceRatio;
        } else {
            height = previewCanvas.height * scale;
            width = height * sourceRatio;
        }
        previewContext.save();
        previewContext.globalAlpha = transform.opacity / 100;
        previewContext.translate(previewCanvas.width / 2 + transform.x, previewCanvas.height / 2 + transform.y);
        previewContext.rotate(transform.rotation * Math.PI / 180);
        previewContext.drawImage(video, -width / 2, -height / 2, width, height);
        previewContext.restore();
    }
    updateViewerLabels();
}

function applyPreviewSize() {
    const wrap = $("#canvas-wrap");
    const availableWidth = Math.max(1, wrap.clientWidth - 40);
    const availableHeight = Math.max(1, wrap.clientHeight - 28);
    const fitScale = Math.min(availableWidth / previewCanvas.width, availableHeight / previewCanvas.height);
    const scale = state.previewZoom || fitScale;
    previewCanvas.style.maxWidth = "none";
    previewCanvas.style.maxHeight = "none";
    previewCanvas.style.width = `${Math.max(1, previewCanvas.width * scale)}px`;
    previewCanvas.style.height = `${Math.max(1, previewCanvas.height * scale)}px`;
    $("#fit-button").title = state.previewZoom ? `Reset ${Math.round(scale * 100)}% zoom to fit` : `Preview fitted at ${Math.round(fitScale * 100)}%`;
}

function togglePlay() {
    if (!state.project.media.length) return;
    state.playing = !state.playing;
    $("#play-button").textContent = state.playing ? "Ⅱ" : "▶";
    if (state.playing) {
        if (state.playhead >= projectDuration() - 1 / state.project.fps) state.playhead = 0;
        state.playStartedAt = performance.now();
        state.playStartedFrom = state.playhead;
        requestAnimationFrame(playLoop);
    } else {
        syncRuntime();
    }
}

function playLoop(now) {
    if (!state.playing) return;
    state.playhead = state.playStartedFrom + (now - state.playStartedAt) / 1000;
    if (state.playhead >= projectDuration()) {
        state.playhead = projectDuration();
        state.playing = false;
        $("#play-button").textContent = "▶";
    }
    updatePlayhead();
    drawPreview();
    if (state.playing) requestAnimationFrame(playLoop);
}

function renderInspector() {
    const result = selected();
    $("#inspector-empty").hidden = Boolean(result);
    $("#inspector").hidden = !result;
    if (!result) return;
    const { clip, track } = result;
    const media = findMedia(clip.mediaId);
    $("#clip-name").textContent = clip.name;
    $("#clip-meta").textContent = `${track.kind === "video" ? "Video" : "Audio"} · ${formatClock(clip.duration)} · ${media?.width || 0}×${media?.height || 0}`;
    $("#clip-thumb").style.backgroundImage = media?.poster ? `url('${media.poster}')` : "";
    $("#clip-thumb").style.backgroundSize = "cover";
    const transformSection = $(".property-section", $("#inspector"));
    transformSection.hidden = track.kind !== "video";
    if (track.kind === "video") {
        const transform = clip.transform ||= defaultTransform();
        $("#prop-scale").value = transform.scale;
        $("#prop-x").value = transform.x;
        $("#prop-y").value = transform.y;
        $("#prop-rotation").value = transform.rotation;
        $("#prop-opacity").value = transform.opacity;
    }
    renderClipAssets(clip, track);
}

function renderClipAssets(clip, track) {
    const root = $("#clip-assets");
    root.innerHTML = "";
    if (track.kind !== "video") {
        root.innerHTML = '<span class="form-help">Assets are attached to video clips.</span>';
        return;
    }
    if (hasMask(clip)) {
        const chip = document.createElement("div");
        chip.className = "asset-chip";
        const maskKinds = [clip.mask?.sam ? "SAM3" : null, clip.mask?.shapes?.length ? "Shapes" : null].filter(Boolean).join(" + ");
        chip.innerHTML = `<span class="mask-icon">◐</span><div><strong>Clip mask</strong><small>${maskKinds}</small></div><button title="Remove mask">×</button>`;
        $("button", chip).onclick = () => {
            checkpoint();
            clip.mask = null;
            renderAll();
        };
        root.append(chip);
    }
    for (const image of clip.images || []) {
        const chip = document.createElement("div");
        chip.className = "asset-chip";
        chip.innerHTML = `<img src="${escapeHtml(image.url)}" alt=""><div><strong>${escapeHtml(image.name)}</strong><small>Frame at ${formatClock(image.sourceTime || 0)}</small></div><button title="Remove image">×</button>`;
        $("button", chip).onclick = () => {
            checkpoint();
            clip.images = clip.images.filter((candidate) => candidate.id !== image.id);
            renderAll();
        };
        root.append(chip);
    }
    if (!root.children.length) root.innerHTML = '<span class="form-help">Masks and edited frames saved from AI tools appear here.</span>';
}

function updateAIButtons() {
    const result = selected();
    const videoClip = result?.track.kind === "video" ? result.clip : null;
    for (const button of $$("#ai-tools button")) {
        const needsBackend = !["simple-mask"].includes(button.dataset.action);
        let disabled = !videoClip || (needsBackend && !state.backend.online);
        if (button.dataset.action === "inpaint" && videoClip && !hasMask(videoClip)) disabled = true;
        if (["i2v", "ref-edit"].includes(button.dataset.action) && videoClip && !(videoClip.images || []).length) disabled = true;
        button.disabled = disabled;
    }
    const help = $("#ai-help");
    if (!videoClip) help.textContent = "Select a video clip to use AI tools.";
    else if (!state.backend.online) help.textContent = "ComfyUI is offline. Simple masks remain available.";
    else if (!hasMask(videoClip)) help.textContent = "Create a mask to enable inpainting. Save an edited frame to enable I2V and reference edit.";
    else help.textContent = "AI tools are ready. Generated videos are placed on the first free track above this clip.";
}

function hasMask(clip) {
    return Boolean(clip.mask?.sam || clip.mask?.shapes?.length || clip.mask?.corrections?.length);
}

function bindInspector() {
    const fields = {
        "#prop-scale": "scale",
        "#prop-x": "x",
        "#prop-y": "y",
        "#prop-rotation": "rotation",
        "#prop-opacity": "opacity",
    };
    for (const [selector, property] of Object.entries(fields)) {
        const input = $(selector);
        input.onfocus = () => input.dataset.before = snapshot();
        input.oninput = () => {
            const result = selected();
            if (!result?.clip.transform) return;
            result.clip.transform[property] = Number(input.value);
            drawPreview();
        };
        input.onchange = () => {
            if (input.dataset.before && input.dataset.before !== snapshot()) checkpoint(input.dataset.before);
            delete input.dataset.before;
        };
    }
    $("#reset-transform").onclick = () => {
        const result = selected();
        if (!result) return;
        checkpoint();
        result.clip.transform = defaultTransform();
        renderAll();
    };
    $("#clear-assets").onclick = () => {
        const result = selected();
        if (!result || (!hasMask(result.clip) && !result.clip.images?.length)) return;
        checkpoint();
        result.clip.mask = null;
        result.clip.images = [];
        renderAll();
    };
}

function apiPath(path) {
    return path;
}

async function apiFetch(path, options = {}) {
    return fetch(apiPath(path), options);
}

async function checkBackend() {
    const pill = $("#backend-pill");
    const wasOnline = state.backend.online;
    try {
        const response = await apiFetch("/system_stats", { cache: "no-store" });
        if (!response.ok) throw new Error();
        state.backend.online = true;
        pill.className = "backend-pill online";
        pill.innerHTML = "<i></i><span>ComfyUI connected</span>";
        connectSocket();
        if (!wasOnline) loadModelLists();
    } catch {
        state.backend.online = false;
        pill.className = "backend-pill offline";
        pill.innerHTML = "<i></i><span>ComfyUI offline</span>";
    }
    updateAIButtons();
}

async function loadModelLists() {
    const folders = ["checkpoints", "diffusion_models", "loras", "text_encoders", "vae", "latent_upscale_models"];
    await Promise.all([...folders.map(async (folder) => {
        try {
            const response = await apiFetch(`/models/${folder}`);
            if (response.ok) state.backend.models[folder] = await response.json();
        } catch {
            state.backend.models[folder] = [];
        }
    }), (async () => {
        try {
            const response = await apiFetch("/object_info");
            if (response.ok) state.backend.nodeTypes = new Set(Object.keys(await response.json()));
        } catch {
            state.backend.nodeTypes = new Set();
        }
    })()]);
}

const clientId = crypto.randomUUID();

function connectSocket() {
    if (state.backend.socket && state.backend.socket.readyState < 2) return;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/ws?clientId=${clientId}`);
    socket.binaryType = "arraybuffer";
    socket.onopen = () => socket.send(JSON.stringify({ type: "feature_flags", data: {} }));
    socket.onmessage = handleSocketMessage;
    socket.onclose = () => {
        state.backend.socket = null;
        if (state.backend.online) setTimeout(connectSocket, 1500);
    };
    state.backend.socket = socket;
}

function handleSocketMessage(event) {
    if (typeof event.data !== "string") {
        const bytes = new Uint8Array(event.data);
        if (bytes.length <= 8) return;
        const blob = new Blob([bytes.slice(8)], { type: bytes[4] === 2 ? "image/png" : "image/jpeg" });
        for (const job of state.backend.jobs.values()) job.onPreview?.(URL.createObjectURL(blob));
        return;
    }
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    const promptId = message.data?.prompt_id;
    const job = promptId ? state.backend.jobs.get(promptId) : null;
    if (!job) return;
    if (message.type === "progress") {
        job.onProgress?.(message.data.value / Math.max(1, message.data.max), "Generating…");
    } else if (message.type === "executing") {
        job.onProgress?.(null, message.data.node ? "Running ComfyUI workflow…" : "Finishing…");
    } else if (message.type === "executed") {
        const resources = findResources(message.data.output || {});
        if (resources.length) job.onIntermediate?.(resources, String(message.data.node));
    } else if (message.type === "execution_error") {
        job.reject(new Error(message.data.exception_message || "ComfyUI generation failed"));
        state.backend.jobs.delete(promptId);
    } else if (message.type === "execution_interrupted") {
        job.reject(new Error("Generation stopped"));
        state.backend.jobs.delete(promptId);
    }
}

async function runPrompt(prompt, callbacks = {}) {
    connectSocket();
    const response = await apiFetch("/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, client_id: clientId }),
    });
    const queued = await response.json();
    if (!response.ok || queued.error) {
        const details = queued.error?.message || queued.error?.details || Object.values(queued.node_errors || {}).map((error) => error.class_type).join(", ");
        throw new Error(details || "ComfyUI rejected the workflow");
    }
    callbacks.onQueued?.(queued.prompt_id);
    return new Promise((resolve, reject) => {
        state.backend.jobs.set(queued.prompt_id, { ...callbacks, resolve, reject });
        pollHistory(queued.prompt_id, resolve, reject, callbacks);
    });
}

async function pollHistory(promptId, resolve, reject, callbacks) {
    const started = Date.now();
    while (state.backend.jobs.has(promptId)) {
        await new Promise((done) => setTimeout(done, 900));
        try {
            const response = await apiFetch(`/history/${promptId}`, { cache: "no-store" });
            if (!response.ok) continue;
            const history = await response.json();
            if (!history[promptId]) {
                if (Date.now() - started > 4 * 60 * 60 * 1000) throw new Error("Generation timed out");
                continue;
            }
            const entry = history[promptId];
            const status = entry.status?.status_str;
            if (status === "error") throw new Error(entry.status?.messages?.at(-1)?.[1]?.exception_message || "ComfyUI generation failed");
            const resources = findResources(entry.outputs || {});
            state.backend.jobs.delete(promptId);
            callbacks.onProgress?.(1, "Complete");
            resolve({ promptId, resources, history: entry });
            return;
        } catch (error) {
            state.backend.jobs.delete(promptId);
            reject(error);
            return;
        }
    }
}

function findResources(output) {
    const resources = [];
    const visit = (value) => {
        if (Array.isArray(value)) {
            value.forEach(visit);
        } else if (value && typeof value === "object") {
            if (typeof value.filename === "string") resources.push(value);
            else Object.values(value).forEach(visit);
        }
    };
    visit(output);
    return resources;
}

function resourceUrl(resource) {
    return `/view?${new URLSearchParams({ filename: resource.filename, subfolder: resource.subfolder || "", type: resource.type || "output" })}`;
}

function annotatedResource(resource) {
    const path = [resource.subfolder, resource.filename].filter(Boolean).join("/");
    return `${path} [${resource.type || "output"}]`;
}

function pickResource(resources, kind) {
    return [...resources].reverse().find((resource) => {
        const extension = resource.filename.split(".").pop().toLowerCase();
        return kind === "video" ? VIDEO_EXTENSIONS.has(extension) : !VIDEO_EXTENSIONS.has(extension);
    });
}

async function uploadBlob(blob, name) {
    const body = new FormData();
    body.append("image", blob, name);
    body.append("subfolder", "video-editor");
    body.append("type", "input");
    const response = await apiFetch("/upload/image", { method: "POST", body });
    if (!response.ok) throw new Error(await response.text() || "Could not upload to ComfyUI");
    const uploaded = await response.json();
    return { filename: uploaded.name, subfolder: uploaded.subfolder || "", type: uploaded.type || "input" };
}

async function ensureMediaUploaded(media) {
    if (media.uploaded) return media.uploaded;
    if (!media.file) {
        if (media.serverRef) return media.serverRef;
        throw new Error("The source media is no longer available. Import it again.");
    }
    media.uploaded = await uploadBlob(media.file, media.name);
    return media.uploaded;
}

async function imageBlobAt(clip, clipTime) {
    const media = findMedia(clip.mediaId);
    const video = document.createElement("video");
    video.src = media.url;
    video.preload = "auto";
    video.muted = true;
    await waitFor(video, "loadeddata");
    const sourceTime = clamp(clip.sourceIn + clipTime, 0, Math.max(0, video.duration - 0.001));
    if (Math.abs(video.currentTime - sourceTime) > .001) {
        video.currentTime = sourceTime;
        await waitFor(video, "seeked");
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

function waitFor(element, event) {
    if (event === "loadedmetadata" && element.readyState >= 1) return Promise.resolve();
    if (event === "loadeddata" && element.readyState >= 2) return Promise.resolve();
    return new Promise((resolve, reject) => {
        element.addEventListener(event, resolve, { once: true });
        element.addEventListener("error", () => reject(new Error("Could not decode media")), { once: true });
    });
}

async function blueprint(name) {
    const response = await fetch(`/video-editor/blueprints/${encodeURIComponent(name)}`);
    if (!response.ok) throw new Error(`Missing bundled workflow: ${name}`);
    return response.json();
}

function graphToPrompt(graph, external = []) {
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    const links = new Map(graph.links.map((link) => [link.id, link]));
    const skipped = new Set(["Reroute", "Note", "MarkdownNote"]);

    const resolveLink = (linkId) => {
        const link = links.get(linkId);
        if (!link) throw new Error(`Broken workflow link ${linkId}`);
        if (link.origin_id === -10) return external[link.origin_slot];
        const origin = nodes.get(link.origin_id);
        if (origin?.type === "Reroute") return resolveLink(origin.inputs?.[0]?.link);
        return [String(link.origin_id), link.origin_slot];
    };

    const prompt = {};
    for (const node of graph.nodes) {
        if (skipped.has(node.type)) continue;
        const inputs = {};
        let widgetIndex = 0;
        for (const input of node.inputs || []) {
            let widgetValue;
            if (input.widget) widgetValue = node.widgets_values?.[widgetIndex++];
            if (input.link != null) inputs[input.name] = resolveLink(input.link);
            else if (input.widget && widgetValue !== undefined) inputs[input.name] = widgetValue;
        }
        prompt[String(node.id)] = { inputs, class_type: node.type, _meta: { title: node.title || node.type } };
    }
    return { prompt, resolveLink };
}

function setNodeInput(prompt, predicate, input, value) {
    for (const node of Object.values(prompt)) if (predicate(node)) node.inputs[input] = value;
}

function nodeTitleIncludes(text) {
    const needle = text.toLowerCase();
    return (node) => (node._meta?.title || "").toLowerCase().includes(needle);
}

function appendModelLoras(prompt, modelLink, loras, prefix = 9500) {
    let link = modelLink;
    let nodeId = prefix;
    for (const lora of loras) {
        if (!lora.file || Number(lora.strength) === 0) continue;
        while (prompt[String(nodeId)]) nodeId++;
        prompt[String(nodeId)] = { inputs: { model: link, lora_name: lora.file, strength_model: Number(lora.strength) }, class_type: "LoraLoaderModelOnly", _meta: { title: `Comfy Cut · ${lora.name || lora.file}` } };
        link = [String(nodeId), 0];
        nodeId++;
    }
    return link;
}

function appendGenerationLoras(prompt, loras) {
    if (!loras.length) return;
    let prefix = 9500;
    for (const node of Object.values(prompt)) {
        if (!/(Guider|Sampler)$/.test(node.class_type) || !Array.isArray(node.inputs.model)) continue;
        node.inputs.model = appendModelLoras(prompt, node.inputs.model, loras, prefix);
        prefix += 100;
    }
}

function generationLoraPicker(root, family) {
    const loras = (state.settings.loraLibrary || []).filter((lora) => lora.family === family && lora.file);
    const wrapper = document.createElement("div");
    wrapper.className = "generation-loras";
    wrapper.innerHTML = `<div class="section-title"><strong>LoRA stack</strong><button class="reset-link open-lora-settings">Manage library</button></div>`;
    $(".open-lora-settings", wrapper).onclick = () => openSettings("loras");
    if (!loras.length) {
        wrapper.insertAdjacentHTML("beforeend", `<span class="form-help">No ${family === "ltx" ? "LTX" : "Krea"} LoRAs are defined. Add them in Settings → LoRAs.</span>`);
    }
    for (const lora of loras) {
        const row = document.createElement("label");
        row.className = "generation-lora-row";
        row.dataset.loraId = lora.id;
        row.innerHTML = `<input class="enabled" type="checkbox" ${lora.default ? "checked" : ""}><span><strong>${escapeHtml(lora.name || lora.file)}</strong><small>${escapeHtml(lora.file)}</small></span><input class="strength" type="number" min="-10" max="10" step="0.05" value="${Number(lora.strength ?? 1)}" title="Model strength">`;
        wrapper.append(row);
    }
    root.append(wrapper);
    return () => $$(".generation-lora-row", wrapper).filter((row) => $(".enabled", row).checked).map((row) => {
        const lora = loras.find((item) => item.id === row.dataset.loraId);
        return { ...lora, strength: Number($(".strength", row).value) };
    });
}

function requireNodes(types, feature) {
    if (!state.backend.nodeTypes.size) return;
    const missing = types.filter((type) => !state.backend.nodeTypes.has(type));
    if (missing.length) throw new Error(`${feature} needs these local custom nodes: ${missing.join(", ")}`);
}

function configureEditAnythingWorkflow(prompt) {
    const nodes = Object.values(prompt);
    const moduleEntry = Object.entries(prompt).find(([, node]) => node.class_type === "LTXVEditAnythingModuleLoader");
    const moduleLoader = moduleEntry?.[1];
    const samplers = nodes.filter((node) => node.class_type === "LTXVEditAnythingLoopingSampler");
    if (!moduleLoader || !samplers.length) throw new Error("The reference workflow must contain LTXVEditAnythingModuleLoader and LTXVEditAnythingLoopingSampler");
    const standardLoaders = nodes.filter((node) => node.class_type === "LoraLoaderModelOnly" && ((node._meta?.title || "").toLowerCase().includes("editanything standard") || node.inputs.lora_name === state.settings.editAnythingStandardLora));
    if (!standardLoaders.length) throw new Error("Name the standard LoRA loader ‘EditAnything standard’ or use {{edit_anything_standard_lora}} as its lora_name");
    moduleLoader.inputs.module_name = state.settings.editAnythingModuleLora;
    for (const loader of standardLoaders) loader.inputs.lora_name = state.settings.editAnythingStandardLora;
    const visual = state.settings.editAnythingMode === "reference-visual";
    for (const sampler of samplers) {
        sampler.inputs.editanything_module = [moduleEntry[0], 0];
        sampler.inputs.lora_name = "(none)";
        sampler.inputs.enable_ic_lora = true;
        sampler.inputs.enable_adaln = true;
        sampler.inputs.reapply_per_chunk = true;
        sampler.inputs.enable_visual_crossattn = visual;
        sampler.inputs.enable_role_embedding = !visual;
        if (visual) {
            sampler.inputs.ref_context_scale = .01;
            sampler.inputs.ref_token_scale = .25;
            sampler.inputs.ref_start_block = 12;
            sampler.inputs.ref_end_block = 35;
            sampler.inputs.ref_init_from = "attn2";
        }
    }
}

async function buildInpaintPrompt(clip, promptText, seed, maskData, loras = []) {
    const data = await blueprint("Video Timeline Edit (LTX-2.3).json");
    const graph = data.definitions.subgraphs[0];
    const { prompt } = graphToPrompt(graph);
    const media = findMedia(clip.mediaId);
    const uploaded = await ensureMediaUploaded(media);
    const fps = state.project.fps;
    const startFrame = Math.round(clip.sourceIn * fps);
    const sourceFrames = Math.max(1, Math.round(media.duration * fps));
    const maxWindow = Math.floor((sourceFrames - 1) / 8) * 8 + 1;
    const endFrame = startFrame + Math.min(maxWindow, Math.max(1, Math.round(clip.duration * fps)));
    setNodeInput(prompt, (node) => node.class_type === "LoadVideo", "file", annotatedResource(uploaded));
    setNodeInput(prompt, (node) => node.class_type === "VideoTimeline", "timeline_data", JSON.stringify({ mode: "inpaint", selection_start: startFrame, selection_end: endFrame, context_before: 2, context_after: 2, mask: maskData }));
    setNodeInput(prompt, (node) => node.class_type === "CheckpointLoaderSimple", "ckpt_name", state.settings.ltxCheckpoint);
    setNodeInput(prompt, nodeTitleIncludes("distilled lora"), "lora_name", state.settings.ltxDistilledLora);
    setNodeInput(prompt, nodeTitleIncludes("in/outpainting"), "lora_name", state.settings.ltxInpaintLora);
    setNodeInput(prompt, (node) => node.class_type === "LTXAVTextEncoderLoader", "text_encoder", state.settings.ltxTextEncoder);
    setNodeInput(prompt, (node) => node.class_type === "LTXAVTextEncoderLoader", "ckpt_name", state.settings.ltxCheckpoint);
    setNodeInput(prompt, (node) => node.class_type === "LTXVAudioVAELoader", "ckpt_name", state.settings.ltxCheckpoint);
    setNodeInput(prompt, nodeTitleIncludes("edit prompt"), "value", promptText);
    setNodeInput(prompt, (node) => node.class_type === "RandomNoise", "noise_seed", seed);
    setNodeInput(prompt, (node) => node.class_type === "SaveVideo", "filename_prefix", "video/ComfyCut_inpaint");
    appendGenerationLoras(prompt, loras);
    return prompt;
}

async function buildI2VPrompt(imageReference, clip, promptText, seed, loras = []) {
    const data = await blueprint("Image to Video (LTX-2.3).json");
    const graph = data.definitions.subgraphs[0];
    const width = Math.max(64, Math.round(state.project.width / 32) * 32);
    const height = Math.max(64, Math.round(state.project.height / 32) * 32);
    const duration = Math.max(1, Math.ceil(clip.duration));
    const loadId = "9000";
    const external = [[loadId, 0], promptText, width, height, duration, state.settings.ltxCheckpoint, state.settings.ltxDistilledLora, state.settings.ltxTextEncoder, state.settings.ltxSpatialUpscaler, Math.round(state.project.fps)];
    const { prompt, resolveLink } = graphToPrompt(graph, external);
    prompt[loadId] = { inputs: { image: annotatedResource(imageReference) }, class_type: "LoadImage", _meta: { title: "Comfy Cut start frame" } };
    const targetFrames = Math.ceil((Math.max(1, Math.round(clip.duration * state.project.fps)) - 1) / 8) * 8 + 1;
    setNodeInput(prompt, (node) => node.class_type === "EmptyLTXVLatentVideo", "length", targetFrames);
    setNodeInput(prompt, (node) => node.class_type === "LTXVEmptyLatentAudio", "frames_number", targetFrames);
    setNodeInput(prompt, (node) => node.class_type === "RandomNoise", "noise_seed", seed);
    const outputLink = graph.outputs[0]?.linkIds?.[0];
    prompt["9001"] = { inputs: { video: resolveLink(outputLink), filename_prefix: "video/ComfyCut_i2v", format: "auto", codec: "auto" }, class_type: "SaveVideo", _meta: { title: "Comfy Cut output" } };
    appendGenerationLoras(prompt, loras);
    return prompt;
}

function buildSamPrompt(videoReference, clip, promptText, options) {
    const detectInputs = {
        model: ["3", 0],
        threshold: options.threshold,
        refine_iterations: options.refine,
        individual_masks: false,
    };
    if (promptText.trim()) detectInputs.conditioning = ["4", 0];
    if (options.positive.length) detectInputs.positive_coords = JSON.stringify(options.positive);
    if (options.negative.length) detectInputs.negative_coords = JSON.stringify(options.negative);
    if (options.boxes.length) detectInputs.bboxes = options.boxes;
    return {
        "1": { inputs: { file: annotatedResource(videoReference) }, class_type: "LoadVideo", _meta: { title: "Source clip" } },
        "2": { inputs: { video: ["1", 0], start_time: clip.sourceIn, duration: clip.duration, strict_duration: false }, class_type: "Video Slice", _meta: { title: "Selected clip only" } },
        "9": { inputs: { video: ["2", 0] }, class_type: "GetVideoComponents", _meta: { title: "Video frames" } },
        "3": { inputs: { ckpt_name: state.settings.samCheckpoint }, class_type: "CheckpointLoaderSimple", _meta: { title: "SAM3 model" } },
        "4": { inputs: { clip: ["3", 1], text: promptText || "object" }, class_type: "CLIPTextEncode", _meta: { title: "Object description" } },
        "5": { inputs: { ...detectInputs, image: ["9", 0] }, class_type: "SAM3_Detect", _meta: { title: "SAM3 segmentation" } },
        "6": { inputs: { mask: ["5", 0] }, class_type: "MaskToImage", _meta: { title: "Mask preview" } },
        "7": { inputs: { images: ["6", 0], fps: ["9", 2] }, class_type: "CreateVideo", _meta: { title: "Mask video" } },
        "8": { inputs: { video: ["7", 0], filename_prefix: "video/ComfyCut_SAM3_mask", format: "auto", codec: "auto" }, class_type: "SaveVideo", _meta: { title: "Save mask" } },
    };
}

function buildKreaImageEditPrompt(imageReference, promptText, seed, width, height, loras = []) {
    const scale = Math.min(1, Math.sqrt(2_000_000 / Math.max(1, width * height)));
    width = Math.max(64, Math.round(width * scale / 16) * 16);
    height = Math.max(64, Math.round(height * scale / 16) * 16);
    const groundingPx = Number.isFinite(Number(state.settings.kreaGroundingPx)) ? Number(state.settings.kreaGroundingPx) : 768;
    const prompt = {
        "1": { inputs: { image: annotatedResource(imageReference) }, class_type: "LoadImage", _meta: { title: "Source frame" } },
        "2": { inputs: { image: ["1", 0], upscale_method: "area", width, height, crop: "disabled" }, class_type: "ImageScale", _meta: { title: "Match edit resolution" } },
        "3": { inputs: { unet_name: state.settings.kreaDiffusionModel, weight_dtype: "default" }, class_type: "UNETLoader", _meta: { title: "Krea 2 Turbo FP8" } },
        "4": { inputs: { clip_name: state.settings.kreaTextEncoder, type: "krea2", device: "default" }, class_type: "CLIPLoader", _meta: { title: "Krea 2 Qwen3-VL" } },
        "5": { inputs: { vae_name: state.settings.kreaVae }, class_type: "VAELoader", _meta: { title: "Krea 2 VAE" } },
        "6": { inputs: { pixels: ["2", 0], vae: ["5", 0] }, class_type: "VAEEncode", _meta: { title: "Source appearance latent" } },
        "7": { inputs: { model: ["3", 0], lora_name: state.settings.kreaEditLora, strength_model: 1 }, class_type: "LoraLoaderModelOnly", _meta: { title: "Krea 2 Edit LoRA" } },
        "8": { inputs: { model: ["7", 0], source_latent: ["6", 0] }, class_type: "Krea2EditModelPatch", _meta: { title: "Krea 2 source patch" } },
        "9": { inputs: { clip: ["4", 0], image: ["2", 0], prompt: promptText, grounding_px: groundingPx }, class_type: "Krea2EditGroundedEncode", _meta: { title: "Grounded edit instruction" } },
        "10": { inputs: { clip: ["4", 0], image: ["2", 0], prompt: "", grounding_px: groundingPx }, class_type: "Krea2EditGroundedEncode", _meta: { title: "Grounded negative" } },
        "11": { inputs: { width, height, batch_size: 1 }, class_type: "EmptySD3LatentImage", _meta: { title: "Output size" } },
        "12": { inputs: { model: ["8", 0], seed, steps: 8, cfg: 1, sampler_name: "euler", scheduler: "simple", positive: ["9", 0], negative: ["10", 0], latent_image: ["11", 0], denoise: 1 }, class_type: "KSampler", _meta: { title: "Krea 2 Turbo sampling" } },
        "13": { inputs: { samples: ["12", 0], vae: ["5", 0] }, class_type: "VAEDecode", _meta: { title: "Decode edit" } },
        "14": { inputs: { images: ["13", 0], filename_prefix: "ComfyCut/Krea_edit" }, class_type: "SaveImage", _meta: { title: "Save edit" } },
    };
    prompt["8"].inputs.model = appendModelLoras(prompt, ["7", 0], loras);
    return prompt;
}

function customWorkflow(json, values) {
    let workflow;
    try { workflow = JSON.parse(json); } catch { throw new Error("The custom workflow is not valid JSON"); }
    if (workflow.prompt) workflow = workflow.prompt;
    const replace = (value) => {
        if (Array.isArray(value)) return value.map(replace);
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
        if (typeof value !== "string") return value;
        const exact = /^\{\{([a-z0-9_]+)\}\}$/i.exec(value);
        if (exact && exact[1] in values) return values[exact[1]];
        return value.replace(/\{\{([a-z0-9_]+)\}\}/gi, (match, key) => key in values ? String(values[key]) : match);
    };
    return replace(workflow);
}

function openModal(title, subtitle, className = "") {
    closeModal();
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `<section class="modal ${className}" role="dialog" aria-modal="true"><header class="modal-header"><div><h2>${escapeHtml(title)}</h2>${subtitle ? `<small>${escapeHtml(subtitle)}</small>` : ""}</div><button class="modal-close" aria-label="Close">×</button></header><div class="modal-body"></div><footer class="modal-footer"></footer></section>`;
    $(".modal-close", backdrop).onclick = closeModal;
    backdrop.onpointerdown = (event) => { if (event.target === backdrop) closeModal(); };
    $("#modal-root").append(backdrop);
    state.activeModal = backdrop;
    return { root: backdrop, body: $(".modal-body", backdrop), footer: $(".modal-footer", backdrop) };
}

function closeModal() {
    state.activeModal?.remove();
    state.activeModal = null;
}

function modalButton(modal, label, callback, style = "secondary") {
    const button = document.createElement("button");
    button.className = `button ${style}`;
    button.textContent = label;
    button.onclick = callback;
    modal.footer.append(button);
    return button;
}

function field(label, control, help = "") {
    const wrapper = document.createElement("label");
    wrapper.className = "form-field";
    wrapper.innerHTML = `<span>${escapeHtml(label)}</span>`;
    wrapper.append(control);
    if (help) wrapper.insertAdjacentHTML("beforeend", `<small class="form-help">${escapeHtml(help)}</small>`);
    return wrapper;
}

function input(type, value, attributes = {}) {
    const element = document.createElement("input");
    element.type = type;
    element.value = value;
    for (const [key, attribute] of Object.entries(attributes)) element.setAttribute(key, attribute);
    return element;
}

function textarea(value, placeholder = "") {
    const element = document.createElement("textarea");
    element.value = value;
    element.placeholder = placeholder;
    return element;
}

async function frameEditor(clip, canvas, onDraw = null) {
    const media = findMedia(clip.mediaId);
    const video = document.createElement("video");
    video.src = media.url;
    video.preload = "auto";
    video.muted = true;
    await waitFor(video, "loadeddata");
    canvas.width = media.width;
    canvas.height = media.height;
    const context = canvas.getContext("2d");
    let lastTime = -1;
    let requested = 0;
    let seeking = false;

    const draw = () => {
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        onDraw?.(context, requested);
    };
    const seek = async (time) => {
        requested = clamp(time, 0, Math.max(0, clip.duration - 1 / state.project.fps));
        if (seeking) return;
        seeking = true;
        while (lastTime !== requested) {
            const target = requested;
            const sourceTime = clamp(clip.sourceIn + target, 0, Math.max(0, video.duration - 0.001));
            if (Math.abs(video.currentTime - sourceTime) > .001) {
                video.currentTime = sourceTime;
                await waitFor(video, "seeked");
            }
            lastTime = target;
            draw();
        }
        seeking = false;
    };
    await seek(0);
    return { video, context, seek, draw, get time() { return requested; } };
}

function canvasPoint(event, canvas) {
    const rect = canvas.getBoundingClientRect();
    return {
        x: clamp((event.clientX - rect.left) / rect.width, 0, 1),
        y: clamp((event.clientY - rect.top) / rect.height, 0, 1),
    };
}

function drawStoredMask(context, mask, time, width, height, tint = "rgba(255,70,82,.62)") {
    if (!mask) return;
    context.save();
    context.fillStyle = tint;
    context.strokeStyle = tint;
    for (const shape of mask.shapes || []) {
        if (time < shape.start || time >= shape.end) continue;
        if (shape.type === "rectangle") {
            context.fillRect(shape.x * width, shape.y * height, shape.w * width, shape.h * height);
        } else if (shape.type === "circle") {
            context.beginPath();
            context.ellipse((shape.x + shape.w / 2) * width, (shape.y + shape.h / 2) * height, Math.abs(shape.w * width / 2), Math.abs(shape.h * height / 2), 0, 0, Math.PI * 2);
            context.fill();
        }
    }
    for (const stroke of mask.corrections || []) {
        if (time < stroke.start || time >= stroke.end || stroke.points.length < 1) continue;
        context.globalCompositeOperation = stroke.mode === "erase" ? "destination-out" : "source-over";
        context.lineWidth = stroke.size * Math.min(width, height);
        context.lineCap = "round";
        context.lineJoin = "round";
        context.beginPath();
        context.moveTo(stroke.points[0].x * width, stroke.points[0].y * height);
        for (const point of stroke.points.slice(1)) context.lineTo(point.x * width, point.y * height);
        if (stroke.points.length === 1) context.lineTo(stroke.points[0].x * width + .01, stroke.points[0].y * height);
        context.stroke();
    }
    context.restore();
}

async function openSimpleMask() {
    const result = selected();
    if (!result || result.track.kind !== "video") return;
    const clip = result.clip;
    const working = structuredClone(clip.mask || { sam: null, shapes: [], corrections: [], morphology: 0 });
    working.shapes ||= [];
    working.corrections ||= [];
    const modal = openModal("Simple mask", clip.name, "mask-modal");
    modal.body.innerHTML = `<div class="modal-grid"><div><div class="mask-toolbar"><button data-tool="rectangle" class="active">Rectangle</button><button data-tool="circle">Circle</button><button data-tool="select">Select</button></div><div class="modal-preview"><canvas></canvas></div><div class="simple-mask-timeline"><div class="mask-time-ruler"><span>Shapes</span><div class="mask-ruler-lane"></div></div><div class="mask-track-list"></div><div class="mask-timeline-playhead-area"><i class="mask-timeline-playhead"></i></div></div><input class="frame-scrub" type="range" min="0" max="${clip.duration}" step="${1 / state.project.fps}" value="0"></div><div class="form-stack"><div><span class="eyebrow">Selected shape</span><h3 class="selected-shape-title">No shape selected</h3></div><label class="form-field"><span>Shape timing</span><div class="inline"><input class="shape-start" type="number" min="0" max="${clip.duration}" step="${1 / state.project.fps}" value="0" disabled><input class="shape-end" type="number" min="0" max="${clip.duration}" step="${1 / state.project.fps}" value="${clip.duration}" disabled></div><small class="form-help">Drag a shape bar or either edge in the timeline. Each shape has its own track.</small></label><button class="button secondary delete-shape" disabled>Delete selected shape</button><button class="button secondary clear-shapes">Clear simple masks</button></div></div>`;
    const canvas = $("canvas", modal.body);
    let currentTool = "rectangle";
    let currentShapeId = working.shapes[0]?.id || null;
    let dragStart = null;
    let draft = null;
    const samVideo = document.createElement("video");
    samVideo.muted = true;
    samVideo.preload = "auto";
    const maskOverlay = document.createElement("canvas");
    const editor = await frameEditor(clip, canvas, (context, time) => {
        if (maskOverlay.width !== canvas.width || maskOverlay.height !== canvas.height) {
            maskOverlay.width = canvas.width;
            maskOverlay.height = canvas.height;
        }
        const maskContext = maskOverlay.getContext("2d", { willReadFrequently: true });
        maskContext.clearRect(0, 0, maskOverlay.width, maskOverlay.height);
        if (samVideo.src && samVideo.readyState >= 2) {
            maskContext.drawImage(samVideo, 0, 0, maskOverlay.width, maskOverlay.height);
            binarizeMask(maskOverlay);
            maskContext.globalCompositeOperation = "source-in";
            maskContext.fillStyle = "#ff4652";
            maskContext.fillRect(0, 0, maskOverlay.width, maskOverlay.height);
            maskContext.globalCompositeOperation = "source-over";
        }
        drawStoredMask(maskContext, { shapes: [...working.shapes, ...(draft ? [draft] : [])], corrections: working.corrections }, time, maskOverlay.width, maskOverlay.height);
        applyMorphology(maskOverlay, Number(working.morphology || 0));
        context.save();
        context.globalAlpha = .62;
        context.drawImage(maskOverlay, 0, 0);
        context.restore();
    });
    let requestedTime = 0;
    let samTime = -1;
    let seeking = false;
    const seek = async (time) => {
        requestedTime = roundFrame(clamp(time, 0, Math.max(0, clip.duration - 1 / state.project.fps)));
        $(".frame-scrub", modal.body).value = requestedTime;
        updateTimeline();
        if (seeking) return;
        seeking = true;
        while (editor.time !== requestedTime || (samVideo.src && samTime !== requestedTime)) {
            const target = requestedTime;
            await editor.seek(target);
            if (samVideo.src) {
                const sourceTime = clamp((working.sam?.trimmed ? working.sam.offset || 0 : clip.sourceIn) + target, 0, Math.max(0, samVideo.duration - .001));
                if (Math.abs(samVideo.currentTime - sourceTime) > .001) {
                    samVideo.currentTime = sourceTime;
                    await waitFor(samVideo, "seeked");
                }
                samTime = target;
                editor.draw();
            }
        }
        seeking = false;
    };
    if (working.sam?.url) {
        samVideo.src = working.sam.url;
        await waitFor(samVideo, "loadedmetadata");
    }

    const updateTimeline = () => {
        const duration = Math.max(clip.duration, 1 / state.project.fps);
        $(".mask-timeline-playhead", modal.body).style.left = `${requestedTime / duration * 100}%`;
        for (const shape of working.shapes) {
            const range = $(`.mask-shape-range[data-shape-id="${shape.id}"]`, modal.body);
            if (!range) continue;
            range.style.left = `${shape.start / duration * 100}%`;
            range.style.width = `${Math.max(1 / state.project.fps, shape.end - shape.start) / duration * 100}%`;
            $("span", range).textContent = `${formatClock(shape.start)}–${formatClock(shape.end)}`;
        }
    };
    const updateSelection = () => {
        const shape = working.shapes.find((candidate) => candidate.id === currentShapeId);
        const index = working.shapes.indexOf(shape);
        $(".selected-shape-title", modal.body).textContent = shape ? `${shape.type === "circle" ? "Circle" : "Rectangle"} ${index + 1}` : "No shape selected";
        $(".shape-start", modal.body).disabled = !shape;
        $(".shape-end", modal.body).disabled = !shape;
        $(".delete-shape", modal.body).disabled = !shape;
        if (shape) {
            $(".shape-start", modal.body).value = shape.start;
            $(".shape-end", modal.body).value = shape.end;
        } else {
            $(".shape-start", modal.body).value = 0;
            $(".shape-end", modal.body).value = clip.duration;
        }
        $$(".mask-track-row", modal.body).forEach((row) => row.classList.toggle("selected", row.dataset.shapeId === currentShapeId));
    };
    const timelineTime = (event, lane) => {
        const rect = lane.getBoundingClientRect();
        return roundFrame(clamp((event.clientX - rect.left) / rect.width * clip.duration, 0, clip.duration));
    };
    const bindScrub = (lane) => {
        lane.onpointerdown = (event) => {
            if (event.button !== 0 || event.target.closest(".mask-shape-range")) return;
            lane.setPointerCapture(event.pointerId);
            seek(timelineTime(event, lane));
            lane.onpointermove = (moveEvent) => seek(timelineTime(moveEvent, lane));
            lane.onpointerup = () => { lane.onpointermove = null; lane.onpointerup = null; };
        };
    };
    const startRangeDrag = (event, shape, lane, mode) => {
        event.stopPropagation();
        currentShapeId = shape.id;
        updateSelection();
        const target = event.currentTarget;
        const pointerStart = timelineTime(event, lane);
        const originalStart = shape.start;
        const originalEnd = shape.end;
        const minimum = 1 / state.project.fps;
        target.setPointerCapture(event.pointerId);
        target.onpointermove = (moveEvent) => {
            const pointer = timelineTime(moveEvent, lane);
            if (mode === "start") shape.start = clamp(pointer, 0, shape.end - minimum);
            else if (mode === "end") shape.end = clamp(pointer, shape.start + minimum, clip.duration);
            else {
                const length = originalEnd - originalStart;
                const start = clamp(originalStart + pointer - pointerStart, 0, clip.duration - length);
                shape.start = roundFrame(start);
                shape.end = roundFrame(start + length);
            }
            updateSelection();
            updateTimeline();
            seek(pointer);
            editor.draw();
        };
        target.onpointerup = () => { target.onpointermove = null; target.onpointerup = null; };
    };
    const renderTracks = () => {
        const list = $(".mask-track-list", modal.body);
        list.innerHTML = working.shapes.length ? "" : '<div class="mask-track-empty">Draw a rectangle or circle to add a shape track.</div>';
        working.shapes.forEach((shape, index) => {
            const row = document.createElement("div");
            row.className = "mask-track-row";
            row.dataset.shapeId = shape.id;
            row.innerHTML = `<button class="mask-track-label"><span>${shape.type === "circle" ? "○" : "□"}</span>${shape.type === "circle" ? "Circle" : "Rectangle"} ${index + 1}</button><div class="mask-track-lane"><div class="mask-shape-range" data-shape-id="${shape.id}"><i class="mask-range-handle left"></i><span>${formatClock(shape.start)}–${formatClock(shape.end)}</span><i class="mask-range-handle right"></i></div></div>`;
            const lane = $(".mask-track-lane", row);
            $(".mask-track-label", row).onclick = () => {
                currentShapeId = shape.id;
                updateSelection();
            };
            const range = $(".mask-shape-range", row);
            range.onpointerdown = (event) => startRangeDrag(event, shape, lane, "move");
            $(".mask-range-handle.left", row).onpointerdown = (event) => startRangeDrag(event, shape, lane, "start");
            $(".mask-range-handle.right", row).onpointerdown = (event) => startRangeDrag(event, shape, lane, "end");
            bindScrub(lane);
            list.append(row);
        });
        updateSelection();
        updateTimeline();
    };
    const selectTool = (tool) => {
        currentTool = tool;
        $$('[data-tool]', modal.body).forEach((button) => button.classList.toggle("active", button.dataset.tool === tool));
    };
    $$('[data-tool]', modal.body).forEach((button) => button.onclick = () => selectTool(button.dataset.tool));
    $(".delete-shape", modal.body).onclick = () => {
        if (!currentShapeId) return;
        working.shapes = working.shapes.filter((shape) => shape.id !== currentShapeId);
        currentShapeId = working.shapes[0]?.id || null;
        renderTracks();
        editor.draw();
    };
    $(".clear-shapes", modal.body).onclick = () => {
        working.shapes = [];
        currentShapeId = null;
        renderTracks();
        editor.draw();
    };
    $(".frame-scrub", modal.body).oninput = (event) => seek(Number(event.target.value));
    bindScrub($(".mask-ruler-lane", modal.body));
    for (const selector of [".shape-start", ".shape-end"]) {
        $(selector, modal.body).onchange = (event) => {
            const shape = working.shapes.find((candidate) => candidate.id === currentShapeId);
            if (!shape) return;
            const minimum = 1 / state.project.fps;
            if (selector.endsWith("start")) shape.start = clamp(roundFrame(Number(event.target.value)), 0, shape.end - minimum);
            else shape.end = clamp(roundFrame(Number(event.target.value)), shape.start + minimum, clip.duration);
            updateSelection();
            updateTimeline();
            editor.draw();
        };
    }
    canvas.onpointerdown = (event) => {
        if (!["rectangle", "circle"].includes(currentTool)) return;
        dragStart = canvasPoint(event, canvas);
        draft = { id: uid("shape"), type: currentTool, x: dragStart.x, y: dragStart.y, w: 0, h: 0, start: Number($(".shape-start", modal.body).value), end: Number($(".shape-end", modal.body).value) };
        canvas.setPointerCapture(event.pointerId);
    };
    canvas.onpointermove = (event) => {
        if (!draft) return;
        const point = canvasPoint(event, canvas);
        draft.x = Math.min(dragStart.x, point.x);
        draft.y = Math.min(dragStart.y, point.y);
        draft.w = Math.abs(point.x - dragStart.x);
        draft.h = Math.abs(point.y - dragStart.y);
        editor.draw();
    };
    canvas.onpointerup = (event) => {
        if (!draft) return;
        canvas.releasePointerCapture(event.pointerId);
        if (draft.w > .005 && draft.h > .005) {
            working.shapes.push(draft);
            currentShapeId = draft.id;
        }
        draft = null;
        renderTracks();
        editor.draw();
    };
    modalButton(modal, "Cancel", closeModal);
    modalButton(modal, "Save mask", () => {
        checkpoint();
        clip.mask = working;
        closeModal();
        renderAll();
        toast("Mask saved", "Simple masks were added to this clip.");
    }, "primary");
    renderTracks();
    seek(0);
}

async function openSamMask() {
    const result = selected();
    if (!result || result.track.kind !== "video" || !state.backend.online) return;
    const clip = result.clip;
    const existing = structuredClone(clip.mask || { sam: null, shapes: [], corrections: [], morphology: 0 });
    existing.corrections ||= [];
    const options = {
        positive: structuredClone(existing.sam?.positive || []),
        negative: structuredClone(existing.sam?.negative || []),
        boxes: structuredClone(existing.sam?.boxes || []),
        threshold: existing.sam?.threshold ?? .5,
        refine: existing.sam?.refine ?? 2,
    };
    const modal = openModal("SAM3 mask", clip.name, "mask-modal");
    modal.body.innerHTML = `<div class="modal-grid"><div><div class="mask-toolbar"><button data-tool="positive" class="active">＋ Point</button><button data-tool="negative">− Point</button><button data-tool="box">□ Box</button><button data-tool="brush">Brush</button><button data-tool="erase">Erase</button><button data-action="clear-prompts">Clear prompts</button></div><div class="modal-preview"><canvas></canvas></div><input class="frame-scrub" type="range" min="0" max="${clip.duration}" step="${1 / state.project.fps}" value="0" style="width:100%;accent-color:var(--accent);margin-top:10px"></div><div class="form-stack"><label class="form-field"><span>What should SAM3 select?</span><textarea class="sam-prompt" placeholder="e.g. the person in the red jacket">${escapeHtml(existing.sam?.prompt || "")}</textarea></label><label class="form-field"><span>Detection threshold</span><input class="sam-threshold" type="range" min="0.05" max="0.95" step="0.01" value="${options.threshold}"></label><label class="form-field"><span>Refinement passes</span><input class="sam-refine" type="number" min="0" max="5" value="${options.refine}"></label><label class="form-field"><span>Brush size</span><input class="brush-size" type="range" min="0.002" max="0.12" step="0.002" value="0.025"></label><div class="segmented"><button data-morph="-1">Contract</button><button data-morph="0" class="active">Original</button><button data-morph="1">Expand</button></div><button class="button primary auto-segment">✦ Auto-segment with SAM3</button><div class="job-slot"></div><small class="form-help">Use text, positive/negative points, or a box. After segmentation, paint or erase corrections frame by frame.</small></div></div>`;
    const canvas = $("canvas", modal.body);
    const overlayVideo = document.createElement("video");
    overlayVideo.muted = true;
    overlayVideo.preload = "auto";
    let tool = "positive";
    let boxStart = null;
    let boxDraft = null;
    let stroke = null;
    const maskOverlay = document.createElement("canvas");
    const editor = await frameEditor(clip, canvas, (context, time) => {
        if (maskOverlay.width !== canvas.width || maskOverlay.height !== canvas.height) {
            maskOverlay.width = canvas.width;
            maskOverlay.height = canvas.height;
        }
        const maskContext = maskOverlay.getContext("2d", { willReadFrequently: true });
        maskContext.clearRect(0, 0, maskOverlay.width, maskOverlay.height);
        if (overlayVideo.src && overlayVideo.readyState >= 2) {
            maskContext.drawImage(overlayVideo, 0, 0, maskOverlay.width, maskOverlay.height);
            binarizeMask(maskOverlay);
            maskContext.globalCompositeOperation = "source-in";
            maskContext.fillStyle = "#ff4652";
            maskContext.fillRect(0, 0, maskOverlay.width, maskOverlay.height);
            maskContext.globalCompositeOperation = "source-over";
        }
        drawStoredMask(maskContext, { corrections: [...existing.corrections, ...(stroke ? [stroke] : [])] }, time, maskOverlay.width, maskOverlay.height);
        applyMorphology(maskOverlay, Number(existing.morphology || 0));
        context.save();
        context.globalAlpha = .62;
        context.drawImage(maskOverlay, 0, 0);
        context.restore();
        context.save();
        for (const point of options.positive) drawPoint(context, point, canvas.width, canvas.height, "#65e35f", time);
        for (const point of options.negative) drawPoint(context, point, canvas.width, canvas.height, "#ff5964", time);
        context.strokeStyle = "#7ec3ff";
        context.lineWidth = Math.max(2, canvas.width / 500);
        for (const box of [...options.boxes, ...(boxDraft ? [boxDraft] : [])]) context.strokeRect(box.x / canvas.width * canvas.width, box.y / canvas.height * canvas.height, box.width / canvas.width * canvas.width, box.height / canvas.height * canvas.height);
        context.restore();
    });

    const seekBoth = async (time) => {
        await editor.seek(time);
        if (!overlayVideo.src) return;
        overlayVideo.currentTime = clamp((existing.sam?.trimmed ? existing.sam.offset || 0 : clip.sourceIn) + time, 0, Math.max(0, overlayVideo.duration - .001));
        await waitFor(overlayVideo, "seeked");
        editor.draw();
    };
    if (existing.sam?.url) {
        overlayVideo.src = existing.sam.url;
        await waitFor(overlayVideo, "loadedmetadata");
        await seekBoth(0);
    }
    const setTool = (next) => {
        tool = next;
        $$('[data-tool]', modal.body).forEach((button) => button.classList.toggle("active", button.dataset.tool === next));
    };
    $$('[data-tool]', modal.body).forEach((button) => button.onclick = () => setTool(button.dataset.tool));
    $(".frame-scrub", modal.body).oninput = (event) => seekBoth(Number(event.target.value));
    $("[data-action=clear-prompts]", modal.body).onclick = () => {
        options.positive = [];
        options.negative = [];
        options.boxes = [];
        editor.draw();
    };
    $$('[data-morph]', modal.body).forEach((button) => button.onclick = () => {
        const change = Number(button.dataset.morph);
        existing.morphology = change === 0 ? 0 : clamp(Number(existing.morphology || 0) + change, -10, 10);
        $$('[data-morph]', modal.body).forEach((candidate) => candidate.classList.toggle("active", Number(candidate.dataset.morph) === Math.sign(existing.morphology)));
        const original = $('[data-morph="0"]', modal.body);
        original.textContent = existing.morphology ? `${existing.morphology > 0 ? "+" : ""}${existing.morphology} steps` : "Original";
        editor.draw();
    });
    if (existing.morphology) {
        $$('[data-morph]', modal.body).forEach((button) => button.classList.toggle("active", Number(button.dataset.morph) === Math.sign(existing.morphology)));
        $('[data-morph="0"]', modal.body).textContent = `${existing.morphology > 0 ? "+" : ""}${existing.morphology} steps`;
    }
    canvas.onpointerdown = (event) => {
        const point = canvasPoint(event, canvas);
        if (tool === "positive" || tool === "negative") {
            options[tool].push({ x: Math.round(point.x * canvas.width), y: Math.round(point.y * canvas.height), time: editor.time });
            editor.draw();
            return;
        }
        if (tool === "box") {
            boxStart = point;
            boxDraft = { x: Math.round(point.x * canvas.width), y: Math.round(point.y * canvas.height), width: 0, height: 0 };
        } else if (tool === "brush" || tool === "erase") {
            stroke = { id: uid("stroke"), mode: tool === "erase" ? "erase" : "add", size: Number($(".brush-size", modal.body).value), start: editor.time, end: editor.time + 1 / state.project.fps, points: [point] };
        }
        canvas.setPointerCapture(event.pointerId);
    };
    canvas.onpointermove = (event) => {
        const point = canvasPoint(event, canvas);
        if (boxDraft) {
            boxDraft.x = Math.round(Math.min(boxStart.x, point.x) * canvas.width);
            boxDraft.y = Math.round(Math.min(boxStart.y, point.y) * canvas.height);
            boxDraft.width = Math.round(Math.abs(point.x - boxStart.x) * canvas.width);
            boxDraft.height = Math.round(Math.abs(point.y - boxStart.y) * canvas.height);
        } else if (stroke) stroke.points.push(point);
        editor.draw();
    };
    canvas.onpointerup = (event) => {
        if (boxDraft && boxDraft.width > 2 && boxDraft.height > 2) options.boxes.push(boxDraft);
        if (stroke) existing.corrections.push(stroke);
        boxDraft = null;
        stroke = null;
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
        editor.draw();
    };
    $(".auto-segment", modal.body).onclick = async () => {
        const promptText = $(".sam-prompt", modal.body).value.trim();
        if (!promptText && !options.positive.length && !options.boxes.length) {
            toast("Add a SAM3 prompt", "Describe an object, add a positive point, or draw a box.", "error");
            return;
        }
        const jobSlot = $(".job-slot", modal.body);
        const job = generationStatus(jobSlot);
        try {
            const media = findMedia(clip.mediaId);
            const reference = await ensureMediaUploaded(media);
            const workflow = buildSamPrompt(reference, clip, promptText, { ...options, threshold: Number($(".sam-threshold", modal.body).value), refine: Number($(".sam-refine", modal.body).value) });
            const result = await runPrompt(workflow, job.callbacks);
            const resource = pickResource(result.resources, "video");
            if (!resource) throw new Error("SAM3 finished without a mask video output");
            overlayVideo.src = resourceUrl(resource);
            await waitFor(overlayVideo, "loadedmetadata");
            existing.sam = { prompt: promptText, ...options, threshold: Number($(".sam-threshold", modal.body).value), refine: Number($(".sam-refine", modal.body).value), resource, url: resourceUrl(resource), trimmed: true, offset: 0 };
            await seekBoth(editor.time);
            job.complete("SAM3 mask ready");
        } catch (error) {
            job.fail(error);
        }
    };
    modalButton(modal, "Cancel", closeModal);
    modalButton(modal, "Clear mask", () => {
        checkpoint();
        clip.mask = null;
        closeModal();
        renderAll();
    }, "secondary");
    modalButton(modal, "Save mask", () => {
        if (!existing.sam && !existing.corrections.length) {
            toast("Nothing to save", "Generate a SAM3 mask or paint a correction first.", "error");
            return;
        }
        checkpoint();
        clip.mask = existing;
        closeModal();
        renderAll();
        toast("SAM3 mask saved", "Open SAM3 mask again at any time to refine it.");
    }, "primary");
}

function drawPoint(context, point, width, height, color, time) {
    if (Math.abs((point.time || 0) - time) > .5 / state.project.fps) return;
    context.beginPath();
    context.arc(point.x / width * width, point.y / height * height, Math.max(5, width / 160), 0, Math.PI * 2);
    context.fillStyle = color;
    context.fill();
    context.strokeStyle = "#fff";
    context.lineWidth = 2;
    context.stroke();
}

function generationStatus(root) {
    root.innerHTML = `<div class="job-progress"><span>Preparing…</span><div class="progress-track"><i></i></div><button class="button secondary stop-job" hidden>Stop generation</button></div>`;
    const label = $("span", root);
    const bar = $("i", root);
    const stop = $(".stop-job", root);
    let promptId = null;
    stop.onclick = async () => {
        if (!promptId) return;
        await apiFetch("/interrupt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt_id: promptId }) });
        label.textContent = "Stopping…";
    };
    return {
        callbacks: {
            onQueued: (id) => { promptId = id; stop.hidden = false; label.textContent = "Queued in ComfyUI…"; },
            onProgress: (progress, text) => { if (progress != null) bar.style.width = `${Math.max(3, progress * 100)}%`; if (text) label.textContent = text; },
            onPreview: (url) => root.dispatchEvent(new CustomEvent("preview", { detail: url })),
            onIntermediate: (resources, nodeId) => root.dispatchEvent(new CustomEvent("intermediate", { detail: { resources, nodeId } })),
        },
        complete(text = "Complete") { label.textContent = text; bar.style.width = "100%"; stop.hidden = true; },
        fail(error) { label.textContent = error.message || String(error); bar.style.width = "100%"; bar.style.background = "var(--danger)"; stop.hidden = true; toast("Generation failed", error.message || String(error), "error"); },
    };
}

async function makeMaskAtlas(clip, onProgress = () => {}) {
    if (!hasMask(clip)) throw new Error("This clip has no mask");
    const media = findMedia(clip.mediaId);
    const frameCount = Math.max(1, Math.round(clip.duration * state.project.fps));
    const tileWidth = Math.min(384, media.width);
    const tileHeight = Math.max(1, Math.round(tileWidth * media.height / media.width));
    const maxColumns = Math.max(1, Math.floor(12000 / tileWidth));
    const columns = Math.min(maxColumns, Math.ceil(Math.sqrt(frameCount * tileHeight / tileWidth)));
    const rows = Math.ceil(frameCount / columns);
    if (rows * tileHeight > 12000) throw new Error("This clip is too long for one mask atlas. Cut it into shorter clips first.");
    const atlas = document.createElement("canvas");
    atlas.width = columns * tileWidth;
    atlas.height = rows * tileHeight;
    const atlasContext = atlas.getContext("2d");
    const tile = document.createElement("canvas");
    tile.width = tileWidth;
    tile.height = tileHeight;
    const tileContext = tile.getContext("2d", { willReadFrequently: true });
    const maskSource = clip.maskSource ? findMedia(clip.maskSource.mediaId) : media;
    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = Math.min(384, maskSource.width);
    maskCanvas.height = Math.max(1, Math.round(maskCanvas.width * maskSource.height / maskSource.width));
    const maskContext = maskCanvas.getContext("2d", { willReadFrequently: true });
    const maskVideo = document.createElement("video");
    if (clip.mask.sam?.url) {
        maskVideo.src = clip.mask.sam.url;
        maskVideo.muted = true;
        maskVideo.preload = "auto";
        await waitFor(maskVideo, "loadedmetadata");
    }
    const frames = [];
    const firstFrame = Math.round(clip.sourceIn * state.project.fps);
    for (let index = 0; index < frameCount; index++) {
        const time = index / state.project.fps;
        tileContext.clearRect(0, 0, tileWidth, tileHeight);
        maskContext.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
        if (maskVideo.src) {
            const sourceIn = clip.maskSource?.sourceIn ?? clip.sourceIn;
            maskVideo.currentTime = clamp((clip.mask.sam?.trimmed ? clip.mask.sam.offset || 0 : sourceIn) + time, 0, Math.max(0, maskVideo.duration - .001));
            await waitFor(maskVideo, "seeked");
            maskContext.drawImage(maskVideo, 0, 0, maskCanvas.width, maskCanvas.height);
            binarizeMask(maskCanvas);
        }
        drawStoredMask(maskContext, clip.mask, time, maskCanvas.width, maskCanvas.height, "white");
        applyMorphology(maskCanvas, Number(clip.mask.morphology || 0));
        if (clip.maskSource?.transform) {
            const transform = clip.maskSource.transform;
            const sourceRatio = maskCanvas.width / maskCanvas.height;
            const targetRatio = tileWidth / tileHeight;
            let width;
            let height;
            if (sourceRatio > targetRatio) {
                width = tileWidth * transform.scale / 100;
                height = width / sourceRatio;
            } else {
                height = tileHeight * transform.scale / 100;
                width = height * sourceRatio;
            }
            tileContext.save();
            tileContext.translate(tileWidth / 2 + transform.x * tileWidth / state.project.width, tileHeight / 2 + transform.y * tileHeight / state.project.height);
            tileContext.rotate(transform.rotation * Math.PI / 180);
            tileContext.drawImage(maskCanvas, -width / 2, -height / 2, width, height);
            tileContext.restore();
        } else {
            tileContext.drawImage(maskCanvas, 0, 0, tileWidth, tileHeight);
        }
        atlasContext.drawImage(tile, index % columns * tileWidth, Math.floor(index / columns) * tileHeight);
        frames.push(firstFrame + index);
        if (index % 6 === 0) {
            onProgress(index / frameCount, "Rendering clip mask…");
            await new Promise((resolve) => requestAnimationFrame(resolve));
        }
    }
    const blob = await new Promise((resolve) => atlas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("Could not encode the clip mask");
    const uploaded = await uploadBlob(blob, `mask-${Date.now()}.png`);
    onProgress(1, "Mask uploaded");
    return { file: annotatedResource(uploaded), frames, columns, width: tileWidth, height: tileHeight };
}

function applyMorphology(canvas, direction) {
    if (!direction) return;
    const context = canvas.getContext("2d");
    const source = document.createElement("canvas");
    source.width = canvas.width;
    source.height = canvas.height;
    source.getContext("2d").drawImage(canvas, 0, 0);
    const radius = Math.min(20, 4 * Math.abs(direction));
    if (direction > 0) {
        for (let y = -radius; y <= radius; y += 2) for (let x = -radius; x <= radius; x += 2) if (x * x + y * y <= radius * radius) context.drawImage(source, x, y);
    } else {
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(source, 0, 0);
        context.globalCompositeOperation = "destination-in";
        for (let y = -radius; y <= radius; y += 2) for (let x = -radius; x <= radius; x += 2) if (x * x + y * y <= radius * radius) context.drawImage(source, x, y);
        context.globalCompositeOperation = "source-over";
    }
}

function binarizeMask(canvas) {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let index = 0; index < image.data.length; index += 4) {
        const visible = image.data[index] + image.data[index + 1] + image.data[index + 2] > 80 ? 255 : 0;
        image.data[index] = 255;
        image.data[index + 1] = 255;
        image.data[index + 2] = 255;
        image.data[index + 3] = visible;
    }
    context.putImageData(image, 0, 0);
}

async function bakeClip(clip, onProgress = () => {}) {
    if (!window.MediaRecorder) throw new Error("This browser cannot bake transformed video clips");
    const media = findMedia(clip.mediaId);
    const video = document.createElement("video");
    video.src = media.url;
    video.preload = "auto";
    video.muted = false;
    video.playsInline = true;
    await waitFor(video, "loadeddata");
    if (Math.abs(video.currentTime - clip.sourceIn) > .001) {
        video.currentTime = clip.sourceIn;
        await waitFor(video, "seeked");
    }
    const canvas = document.createElement("canvas");
    canvas.width = state.project.width;
    canvas.height = state.project.height;
    const context = canvas.getContext("2d");
    const stream = canvas.captureStream(state.project.fps);
    let audioContext;
    try {
        audioContext = new AudioContext();
        const source = audioContext.createMediaElementSource(video);
        const destination = audioContext.createMediaStreamDestination();
        source.connect(destination);
        destination.stream.getAudioTracks().forEach((track) => stream.addTrack(track));
    } catch {
        audioContext = null;
    }
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus") ? "video/webm;codecs=vp9,opus" : "video/webm";
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 12_000_000 });
    const chunks = [];
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    const finished = new Promise((resolve, reject) => {
        recorder.onstop = resolve;
        recorder.onerror = () => reject(new Error("Could not render the transformed clip"));
    });
    const transform = clip.transform || defaultTransform();
    const started = performance.now();
    recorder.start(500);
    await video.play();
    await new Promise((resolve) => {
        const draw = () => {
            const elapsed = (performance.now() - started) / 1000;
            context.fillStyle = "black";
            context.fillRect(0, 0, canvas.width, canvas.height);
            const sourceRatio = video.videoWidth / video.videoHeight;
            const targetRatio = canvas.width / canvas.height;
            let width;
            let height;
            if (sourceRatio > targetRatio) {
                width = canvas.width * transform.scale / 100;
                height = width / sourceRatio;
            } else {
                height = canvas.height * transform.scale / 100;
                width = height * sourceRatio;
            }
            context.save();
            context.globalAlpha = transform.opacity / 100;
            context.translate(canvas.width / 2 + transform.x, canvas.height / 2 + transform.y);
            context.rotate(transform.rotation * Math.PI / 180);
            context.drawImage(video, -width / 2, -height / 2, width, height);
            context.restore();
            onProgress(clamp(elapsed / clip.duration, 0, .99), "Baking clip transforms in real time…");
            if (elapsed >= clip.duration || video.currentTime >= clip.sourceIn + clip.duration) resolve();
            else requestAnimationFrame(draw);
        };
        draw();
    });
    video.pause();
    recorder.stop();
    await finished;
    await audioContext?.close();
    stream.getTracks().forEach((track) => track.stop());
    const blob = new Blob(chunks, { type: mimeType });
    const uploaded = await uploadBlob(blob, `transformed-${Date.now()}.webm`);
    onProgress(1, "Transformed clip ready");
    const temporaryMedia = { id: uid("render"), name: "Transformed clip", url: URL.createObjectURL(blob), file: blob, uploaded, serverRef: uploaded, duration: clip.duration, width: state.project.width, height: state.project.height };
    const temporaryClip = { ...structuredClone(clip), mediaId: temporaryMedia.id, sourceIn: 0, sourceDuration: clip.duration, transform: defaultTransform(), maskSource: { mediaId: clip.mediaId, sourceIn: clip.sourceIn, transform: structuredClone(clip.transform || defaultTransform()) } };
    state.project.media.push(temporaryMedia);
    return { clip: temporaryClip, media: temporaryMedia, cleanup: () => {
        state.project.media = state.project.media.filter((item) => item.id !== temporaryMedia.id);
        URL.revokeObjectURL(temporaryMedia.url);
    } };
}

async function openInpaint() {
    const result = selected();
    if (!result || result.track.kind !== "video" || !hasMask(result.clip)) return;
    const sourceClip = result.clip;
    const modal = openModal("Inpaint", sourceClip.name, "wide");
    modal.body.innerHTML = `<div class="modal-grid"><div class="generation-preview"><video class="source-preview" src="${escapeHtml(findMedia(sourceClip.mediaId).url)}" controls></video><span class="generation-empty" hidden></span></div><div class="form-stack"><label class="form-field"><span>Prompt</span><textarea class="prompt" placeholder="Describe what should replace the masked area"></textarea></label><label class="form-field"><span>Seed</span><input class="seed" type="number" min="0" max="9007199254740991" value="${randomSeed()}"></label><label class="toggle-row"><span>Use clip scale, position, and rotation</span><input class="use-transform" type="checkbox"></label><small class="form-help">When enabled, the transform is baked before generation. Empty canvas areas become outpainting regions. Baking takes the clip's duration in real time.</small><button class="button primary generate">Generate</button><div class="job-slot"></div></div></div>`;
    const sourceVideo = $(".source-preview", modal.body);
    const selectedLoras = generationLoraPicker($(".form-stack", modal.body), "ltx");
    sourceVideo.currentTime = sourceClip.sourceIn;
    let output = null;
    let generatedSourceIn = sourceClip.sourceIn;
    const generate = $(".generate", modal.body);
    const jobSlot = $(".job-slot", modal.body);
    const preview = $(".generation-preview", modal.body);
    generate.onclick = async () => {
        const promptText = $(".prompt", modal.body).value.trim();
        if (!promptText) return toast("Add an inpaint prompt", "Describe the intended result.", "error");
        generate.disabled = true;
        const job = generationStatus(jobSlot);
        let baked = null;
        try {
            const useTransform = $(".use-transform", modal.body).checked;
            let clip = sourceClip;
            if (useTransform) {
                baked = await bakeClip(sourceClip, job.callbacks.onProgress);
                clip = baked.clip;
                clip.mask = structuredClone(sourceClip.mask);
                generatedSourceIn = 0;
            } else generatedSourceIn = sourceClip.sourceIn;
            const atlas = await makeMaskAtlas(clip, job.callbacks.onProgress);
            const workflow = await buildInpaintPrompt(clip, promptText, Number($(".seed", modal.body).value), atlas, selectedLoras());
            jobSlot.addEventListener("preview", (event) => showJobImage(preview, event.detail), { once: false });
            jobSlot.addEventListener("intermediate", (event) => {
                if (event.detail.nodeId === "2") return;
                const resource = pickResource(event.detail.resources, "video");
                if (resource) showJobVideo(preview, resourceUrl(resource), generatedSourceIn, sourceClip.duration);
            });
            const generated = await runPrompt(workflow, job.callbacks);
            const resource = pickResource(generated.resources, "video");
            if (!resource) throw new Error("The inpaint workflow completed without a video output");
            output = resource;
            showJobVideo(preview, resourceUrl(resource), generatedSourceIn, sourceClip.duration);
            job.complete("Generation ready — preview it, then save");
        } catch (error) {
            job.fail(error);
        } finally {
            baked?.cleanup();
            generate.disabled = false;
        }
    };
    modalButton(modal, "Cancel", closeModal);
    const save = modalButton(modal, "Save to timeline", async () => {
        if (!output) return toast("Generate a clip first", "Preview a result before saving it.", "error");
        await addGeneratedClip(output, sourceClip, generatedSourceIn, "Inpaint");
        closeModal();
    }, "primary");
    save.title = "Adds the result to the first free video track above the source";
}

function randomSeed() {
    return Math.floor(Math.random() * 2 ** 32);
}

function showJobImage(preview, url) {
    let image = $("img", preview);
    if (!image) {
        preview.innerHTML = "";
        image = document.createElement("img");
        preview.append(image);
    }
    image.src = url;
}

function showJobVideo(preview, url, start = 0, duration = null) {
    preview.innerHTML = `<video src="${escapeHtml(url)}" controls autoplay></video>`;
    const video = $("video", preview);
    video.onloadedmetadata = () => {
        video.currentTime = clamp(start, 0, Math.max(0, video.duration - .001));
        video.play().catch(() => {});
    };
    video.ontimeupdate = () => {
        if (duration != null && video.currentTime >= start + duration) video.currentTime = start;
    };
}

async function addGeneratedClip(resource, sourceClip, sourceIn, label) {
    const url = resourceUrl(resource);
    const video = document.createElement("video");
    video.src = url;
    video.preload = "metadata";
    await waitFor(video, "loadedmetadata");
    const media = {
        id: uid("media"),
        name: `${label} · ${sourceClip.name}`,
        url,
        file: null,
        duration: video.duration,
        width: video.videoWidth,
        height: video.videoHeight,
        poster: await makePoster(video),
        uploaded: resource,
        serverRef: resource,
        generated: true,
    };
    checkpoint();
    state.project.media.push(media);
    const original = findClip(sourceClip.id);
    const originalIndex = state.project.tracks.findIndex((track) => track.id === original?.track.id);
    let target = null;
    for (let index = originalIndex - 1; index >= 0; index--) {
        const candidate = state.project.tracks[index];
        if (candidate.kind === "video" && !candidate.clips.some((clip) => rangesOverlap(clip.start, clip.start + clip.duration, sourceClip.start, sourceClip.start + sourceClip.duration))) {
            target = candidate;
            break;
        }
    }
    if (!target) {
        target = { id: uid("track"), kind: "video", name: `Video ${state.project.tracks.filter((track) => track.kind === "video").length + 1}`, enabled: true, clips: [] };
        state.project.tracks.unshift(target);
    }
    const clip = {
        id: uid("clip"), mediaId: media.id, name: media.name, start: sourceClip.start, duration: sourceClip.duration,
        sourceIn, sourceDuration: media.duration, linkedId: null, transform: defaultTransform(), mask: null, images: [], generated: true,
    };
    target.clips.push(clip);
    state.selectedClipId = clip.id;
    renderAll();
    toast("Added to timeline", `${label} was placed above the source clip.`);
}

function rangesOverlap(startA, endA, startB, endB) {
    return startA < endB && startB < endA;
}

async function openImageEdit() {
    const result = selected();
    if (!result || result.track.kind !== "video") return;
    const clip = result.clip;
    const media = findMedia(clip.mediaId);
    const modal = openModal("Image edit", clip.name, "wide");
    modal.body.innerHTML = `<div class="modal-grid"><div><div class="generation-preview frame-preview"><canvas></canvas></div><input class="frame-scrub" type="range" min="0" max="${clip.duration}" step="${1 / state.project.fps}" value="0" style="width:100%;accent-color:var(--accent);margin-top:10px"><div class="generation-preview result-preview" hidden></div></div><div class="form-stack"><label class="form-field"><span>Prompt</span><textarea class="prompt" placeholder="Describe how this frame should change"></textarea></label><label class="form-field"><span>Seed</span><input class="seed" type="number" value="${randomSeed()}"></label><button class="button primary generate">Generate with Krea 2 Edit</button><div class="job-slot"></div></div></div>`;
    const canvas = $("canvas", modal.body);
    const editor = await frameEditor(clip, canvas);
    const selectedLoras = generationLoraPicker($(".form-stack", modal.body), "krea");
    $(".frame-scrub", modal.body).oninput = (event) => editor.seek(Number(event.target.value));
    let output = null;
    $(".generate", modal.body).onclick = async () => {
        const promptText = $(".prompt", modal.body).value.trim();
        if (!promptText) return toast("Add an edit prompt", "Describe how the chosen frame should change.", "error");
        if (!state.settings.imageEditWorkflow.trim() && (!state.settings.kreaDiffusionModel || !state.settings.kreaTextEncoder || !state.settings.kreaVae || !state.settings.kreaEditLora)) {
            return toast("Complete the Krea 2 setup", "Choose the diffusion model, Qwen3-VL encoder, VAE, and edit LoRA in Settings → Models.", "error");
        }
        const job = generationStatus($(".job-slot", modal.body));
        try {
            const blob = await imageBlobAt(clip, editor.time);
            const reference = await uploadBlob(blob, `frame-${Date.now()}.png`);
            const values = workflowValues({ clip, prompt: promptText, seed: Number($(".seed", modal.body).value), sourceImage: reference, referenceImage: reference });
            const loras = selectedLoras();
            let workflow;
            if (state.settings.imageEditWorkflow.trim()) {
                workflow = customWorkflow(state.settings.imageEditWorkflow, values);
                appendGenerationLoras(workflow, loras);
            } else {
                requireNodes(["Krea2EditModelPatch", "Krea2EditGroundedEncode"], "Krea 2 image edit");
                workflow = buildKreaImageEditPrompt(reference, promptText, values.seed, media.width, media.height, loras);
            }
            const generated = await runPrompt(workflow, job.callbacks);
            const resource = pickResource(generated.resources, "image");
            if (!resource) throw new Error("The image edit workflow completed without an image output");
            output = { resource, url: resourceUrl(resource), time: editor.time };
            const resultPreview = $(".result-preview", modal.body);
            resultPreview.hidden = false;
            resultPreview.innerHTML = `<img src="${escapeHtml(output.url)}" alt="Generated edit">`;
            job.complete("Edited frame ready");
        } catch (error) {
            job.fail(error);
        }
    };
    modalButton(modal, "Cancel", closeModal);
    modalButton(modal, "Save image to clip", () => {
        if (!output) return toast("Generate an image first", "Save becomes available after a successful edit.", "error");
        checkpoint();
        clip.images ||= [];
        clip.images.push({ id: uid("image"), name: `Krea edit ${clip.images.length + 1}`, url: output.url, resource: output.resource, sourceTime: output.time });
        closeModal();
        renderAll();
        toast("Image attached", "It is now available for image-to-video and reference edit.");
    }, "primary");
}

function workflowValues({ clip, prompt, seed, sourceImage, referenceImage, sourceVideo, maskImage }) {
    return {
        prompt,
        seed,
        source_image: sourceImage ? annotatedResource(sourceImage) : "",
        reference_image: referenceImage ? annotatedResource(referenceImage) : "",
        source_video: sourceVideo ? annotatedResource(sourceVideo) : "",
        mask_image: maskImage ? annotatedResource(maskImage) : "",
        width: state.project.width,
        height: state.project.height,
        fps: state.project.fps,
        duration: clip.duration,
        frame_count: Math.ceil((Math.round(clip.duration * state.project.fps) - 1) / 8) * 8 + 1,
        ltx_checkpoint: state.settings.ltxCheckpoint,
        ltx_distilled_lora: state.settings.ltxDistilledLora,
        ltx_inpaint_lora: state.settings.ltxInpaintLora,
        ltx_text_encoder: state.settings.ltxTextEncoder,
        ltx_spatial_upscaler: state.settings.ltxSpatialUpscaler,
        krea_diffusion_model: state.settings.kreaDiffusionModel,
        krea_text_encoder: state.settings.kreaTextEncoder,
        krea_vae: state.settings.kreaVae,
        krea_edit_lora: state.settings.kreaEditLora,
        edit_anything_standard_lora: state.settings.editAnythingStandardLora,
        edit_anything_module_lora: state.settings.editAnythingModuleLora,
        edit_anything_enable_visual_crossattn: state.settings.editAnythingMode === "reference-visual",
        edit_anything_enable_role_embedding: state.settings.editAnythingMode === "reference-role",
        edit_anything_enable_adaln: true,
        sam_checkpoint: state.settings.samCheckpoint,
    };
}

async function chooseAttachedImage(clip, title, family, onChoose) {
    const modal = openModal(title, clip.name, "wide");
    modal.body.innerHTML = '<div class="asset-picker"></div>';
    const picker = $(".asset-picker", modal.body);
    let selectedImage = clip.images[0] || null;
    for (const image of clip.images) {
        const choice = document.createElement("button");
        choice.className = `asset-choice${image === selectedImage ? " selected" : ""}`;
        choice.innerHTML = `<img src="${escapeHtml(image.url)}" alt=""><span>${escapeHtml(image.name)}</span>`;
        choice.onclick = () => {
            selectedImage = image;
            $$(".asset-choice", picker).forEach((candidate) => candidate.classList.toggle("selected", candidate === choice));
        };
        picker.append(choice);
    }
    const controls = document.createElement("div");
    controls.className = "form-stack";
    controls.style.marginTop = "16px";
    controls.innerHTML = `<label class="form-field"><span>Prompt</span><textarea class="prompt" placeholder="Describe the video you want to create"></textarea></label><label class="form-field"><span>Seed</span><input class="seed" type="number" value="${randomSeed()}"></label><button class="button primary generate">Generate</button><div class="generation-preview result-preview"><span class="generation-empty">Choose an image, enter a prompt, and generate.</span></div><div class="job-slot"></div>`;
    modal.body.append(controls);
    const selectedLoras = generationLoraPicker(controls, family);
    let output = null;
    $(".generate", controls).onclick = async () => {
        if (!selectedImage) return;
        const promptText = $(".prompt", controls).value.trim();
        if (!promptText) return toast("Add a prompt", "Describe the intended result.", "error");
        const job = generationStatus($(".job-slot", controls));
        try {
            output = await onChoose(selectedImage, promptText, Number($(".seed", controls).value), job, selectedLoras());
            showJobVideo($(".result-preview", controls), resourceUrl(output));
            job.complete("Generation ready");
        } catch (error) {
            job.fail(error);
        }
    };
    modalButton(modal, "Cancel", closeModal);
    modalButton(modal, "Save to timeline", async () => {
        if (!output) return toast("Generate a clip first", "Preview a result before saving it.", "error");
        await addGeneratedClip(output, clip, 0, title);
        closeModal();
    }, "primary");
}

async function openI2V() {
    const result = selected();
    if (!result || result.track.kind !== "video" || !result.clip.images?.length) return;
    const clip = result.clip;
    await chooseAttachedImage(clip, "Image to video", "ltx", async (image, promptText, seed, job, loras) => {
        const workflow = await buildI2VPrompt(image.resource, clip, promptText, seed, loras);
        const generated = await runPrompt(workflow, job.callbacks);
        const resource = pickResource(generated.resources, "video");
        if (!resource) throw new Error("The I2V workflow completed without a video output");
        return resource;
    });
}

async function openRefEdit() {
    const result = selected();
    if (!result || result.track.kind !== "video" || !result.clip.images?.length) return;
    const clip = result.clip;
    if (!state.settings.editAnythingStandardLora || !state.settings.editAnythingModuleLora) {
        toast("Complete the EditAnything setup", "Select a matched standard and module LoRA pair in Settings → Models.", "error");
        openSettings("models");
        return;
    }
    try {
        requireNodes(["LTXVEditAnythingModuleLoader", "LTXVEditAnythingLoopingSampler"], "EditAnything reference edit");
    } catch (error) {
        toast("EditAnything nodes are missing", error.message, "error");
        return;
    }
    if (!state.settings.refEditWorkflow.trim()) {
        toast("Reference workflow needed", "Add an EditAnything LTX 2.3 API workflow in Settings → Workflows.", "error");
        openSettings("workflows");
        return;
    }
    await chooseAttachedImage(clip, "Reference edit", "ltx", async (image, promptText, seed, job, loras) => {
        const media = findMedia(clip.mediaId);
        const sourceVideo = await ensureMediaUploaded(media);
        const values = workflowValues({ clip, prompt: promptText, seed, sourceVideo, referenceImage: image.resource });
        const workflow = customWorkflow(state.settings.refEditWorkflow, values);
        configureEditAnythingWorkflow(workflow);
        appendGenerationLoras(workflow, loras);
        const generated = await runPrompt(workflow, job.callbacks);
        const resource = pickResource(generated.resources, "video");
        if (!resource) throw new Error("The reference edit workflow completed without a video output");
        return resource;
    });
}

function openSettings(initialPage = "models") {
    const modal = openModal("Settings", "Comfy Cut", "wide");
    modal.body.style.padding = "0";
    modal.body.innerHTML = `<div class="settings-tabs"><nav class="settings-nav"><button data-page="models">Models</button><button data-page="loras">LoRAs</button><button data-page="project">Project</button><button data-page="workflows">Workflows</button><button data-page="about">About</button></nav><div class="settings-page"></div></div>`;
    const draft = { ...structuredClone(state.settings), projectName: state.project.name };
    const renderPage = (page) => {
        $$('[data-page]', modal.body).forEach((button) => button.classList.toggle("active", button.dataset.page === page));
        const root = $(".settings-page", modal.body);
        if (page === "models") renderModelSettings(root, draft);
        else if (page === "loras") renderLoraSettings(root, draft);
        else if (page === "project") renderProjectSettings(root, draft);
        else if (page === "workflows") renderWorkflowSettings(root, draft);
        else root.innerHTML = `<h3>About Comfy Cut</h3><p>A local, standalone video editor for ComfyUI. Media stays on this machine and AI jobs are sent only to the ComfyUI server that is serving this page.</p><div class="job-progress"><span>${state.backend.online ? "ComfyUI is connected" : "ComfyUI is unavailable"}</span><div class="progress-track"><i style="width:${state.backend.online ? 100 : 0}%"></i></div></div>`;
    };
    $$('[data-page]', modal.body).forEach((button) => button.onclick = () => renderPage(button.dataset.page));
    modalButton(modal, "Cancel", closeModal);
    modalButton(modal, "Save settings", () => {
        state.settings = draft;
        state.project.width = clamp(Number(draft.projectWidth) || 1920, 64, 8192);
        state.project.height = clamp(Number(draft.projectHeight) || 1080, 64, 8192);
        state.project.fps = clamp(Number(draft.projectFps) || 30, 1, 120);
        state.project.name = draft.projectName || "Untitled sequence";
        saveSettings();
        closeModal();
        renderAll();
        toast("Settings saved", "New AI jobs will use the selected models.");
    }, "primary");
    renderPage(initialPage);
}

function modelInput(root, draft, label, key, folder, help = "") {
    const id = `models-${key}`;
    const control = input("text", draft[key] || "", { list: id, autocomplete: "off" });
    const list = document.createElement("datalist");
    list.id = id;
    for (const model of state.backend.models[folder] || []) list.insertAdjacentHTML("beforeend", `<option value="${escapeHtml(model)}"></option>`);
    control.oninput = () => draft[key] = control.value;
    root.append(field(label, control, help), list);
}

function renderModelSettings(root, draft) {
    root.innerHTML = `<h3>AI models</h3><p>Choose installed ComfyUI models. Lists come from this server's model folders; model downloads are never started by the editor.</p><div class="settings-fields"></div>`;
    const fields = $(".settings-fields", root);
    modelInput(fields, draft, "SAM3 checkpoint", "samCheckpoint", "checkpoints");
    modelInput(fields, draft, "LTX 2.3 checkpoint", "ltxCheckpoint", "checkpoints");
    modelInput(fields, draft, "LTX distilled LoRA", "ltxDistilledLora", "loras");
    modelInput(fields, draft, "In/Outpaint IC-LoRA", "ltxInpaintLora", "loras");
    modelInput(fields, draft, "LTX text encoder", "ltxTextEncoder", "text_encoders");
    modelInput(fields, draft, "LTX spatial upscaler", "ltxSpatialUpscaler", "latent_upscale_models");
    modelInput(fields, draft, "Krea 2 Turbo FP8 diffusion model", "kreaDiffusionModel", "diffusion_models", "The original Turbo FP8 file belongs in models/diffusion_models, not checkpoints.");
    modelInput(fields, draft, "Krea 2 Qwen3-VL text encoder", "kreaTextEncoder", "text_encoders");
    modelInput(fields, draft, "Krea 2 VAE", "kreaVae", "vae", "Usually qwen_image_vae.safetensors.");
    modelInput(fields, draft, "Krea 2 Edit LoRA", "kreaEditLora", "loras", "The edit LoRA is applied before the source-latent patch.");
    const grounding = input("number", draft.kreaGroundingPx ?? 768, { min: 0, max: 4096, step: 64 });
    grounding.oninput = () => draft.kreaGroundingPx = Number(grounding.value);
    fields.append(field("Krea grounding size", grounding, "Caps the longest source-image side sent through Qwen3-VL. 768 matches the edit workflow default."));
    const mode = document.createElement("select");
    mode.innerHTML = '<option value="reference-visual">Reference · four extras / visual cross-attention</option><option value="reference-role">Reference · two extras / role embedding</option>';
    mode.value = draft.editAnythingMode || "reference-visual";
    mode.onchange = () => draft.editAnythingMode = mode.value;
    fields.append(field("EditAnything reference variant", mode, "Choose the variant that matches the standard/module LoRA pair."));
    modelInput(fields, draft, "EditAnything standard LoRA", "editAnythingStandardLora", "loras", "Load this through the normal model LoRA path.");
    modelInput(fields, draft, "EditAnything module LoRA", "editAnythingModuleLora", "loras", "A matching .module file loaded by BFSNodes.");
    fields.insertAdjacentHTML("beforeend", '<div class="full form-help model-note">Krea image edit requires the local Krea2EditModelPatch and Krea2EditGroundedEncode custom nodes. EditAnything reference edit requires the local ComfyUI-BFSNodes EditAnything nodes. The editor never downloads or calls a hosted API.</div>');
}

function renderLoraSettings(root, draft) {
    draft.loraLibrary ||= [];
    root.innerHTML = `<h3>Generation LoRA library</h3><p>Define reusable local LoRAs, their model family, strength, and whether they are enabled by default. Every generation window lets you override the stack without changing these defaults.</p><div class="lora-library"></div><button class="button secondary add-lora">＋ Add LoRA</button><datalist id="lora-library-models"></datalist>`;
    const datalist = $("#lora-library-models", root);
    for (const model of state.backend.models.loras || []) datalist.insertAdjacentHTML("beforeend", `<option value="${escapeHtml(model)}"></option>`);
    const renderRows = () => {
        const library = $(".lora-library", root);
        library.innerHTML = draft.loraLibrary.length ? "" : '<div class="lora-library-empty">No reusable LoRAs yet.</div>';
        draft.loraLibrary.forEach((lora) => {
            const row = document.createElement("div");
            row.className = "lora-library-row";
            row.innerHTML = `<label><span>Name</span><input class="lora-name" type="text" value="${escapeHtml(lora.name || "")}" placeholder="Style LoRA"></label><label><span>Model</span><select class="lora-family"><option value="ltx">LTX 2.3</option><option value="krea">Krea 2</option></select></label><label class="lora-file"><span>Installed file</span><input type="text" list="lora-library-models" value="${escapeHtml(lora.file || "")}" placeholder="folder/model.safetensors"></label><label><span>Strength</span><input class="lora-strength" type="number" min="-10" max="10" step="0.05" value="${Number(lora.strength ?? 1)}"></label><label class="lora-default"><input type="checkbox" ${lora.default ? "checked" : ""}><span>Use by default</span></label><button class="small-icon remove-lora" title="Remove LoRA">×</button>`;
            $(".lora-family", row).value = lora.family || "ltx";
            $(".lora-name", row).oninput = (event) => lora.name = event.target.value;
            $(".lora-family", row).onchange = (event) => lora.family = event.target.value;
            $(".lora-file input", row).oninput = (event) => lora.file = event.target.value;
            $(".lora-strength", row).oninput = (event) => lora.strength = Number(event.target.value);
            $(".lora-default input", row).onchange = (event) => lora.default = event.target.checked;
            $(".remove-lora", row).onclick = () => {
                draft.loraLibrary = draft.loraLibrary.filter((item) => item.id !== lora.id);
                renderRows();
            };
            library.append(row);
        });
    };
    $(".add-lora", root).onclick = () => {
        draft.loraLibrary.push({ id: uid("lora"), name: "", file: "", family: "ltx", strength: 1, default: false });
        renderRows();
    };
    renderRows();
}

function renderProjectSettings(root, draft) {
    root.innerHTML = `<h3>Project format</h3><p>These values define the preview canvas, timeline frame grid, mask frame count, and generated video requests.</p><div class="settings-fields"></div>`;
    const fields = $(".settings-fields", root);
    for (const [label, key, min, max] of [["Width", "projectWidth", 64, 8192], ["Height", "projectHeight", 64, 8192], ["Frame rate", "projectFps", 1, 120]]) {
        const control = input("number", draft[key], { min, max, step: 1 });
        control.oninput = () => draft[key] = Number(control.value);
        fields.append(field(label, control));
    }
    const name = input("text", draft.projectName);
    name.oninput = () => draft.projectName = name.value;
    const wrapper = field("Sequence name", name);
    wrapper.classList.add("full");
    fields.append(wrapper);
}

function renderWorkflowSettings(root, draft) {
    root.innerHTML = `<h3>Advanced workflow overrides</h3><p>Inpaint, I2V, SAM3, and Krea use local graphs. Paste API-format JSON here only when a model needs a custom graph. Reference edit uses a user-supplied EditAnything graph because its guide-video layout is model-specific.</p><div class="settings-fields"></div>`;
    const fields = $(".settings-fields", root);
    const imageEdit = textarea(draft.imageEditWorkflow || "", '{ "1": { "class_type": "LoadImage", "inputs": { "image": "{{source_image}}" } } }');
    imageEdit.className = "advanced-workflow";
    imageEdit.oninput = () => draft.imageEditWorkflow = imageEdit.value;
    const imageField = field("Image edit API workflow (optional)", imageEdit, "Use {{source_image}}, {{prompt}}, {{seed}}, {{krea_diffusion_model}}, {{krea_text_encoder}}, {{krea_vae}}, and {{krea_edit_lora}} placeholders.");
    imageField.classList.add("full");
    fields.append(imageField);
    const refEdit = textarea(draft.refEditWorkflow || "", '{ "1": { "class_type": "LoadVideo", "inputs": { "file": "{{source_video}}" } } }');
    refEdit.className = "advanced-workflow";
    refEdit.oninput = () => draft.refEditWorkflow = refEdit.value;
    const refField = field("EditAnything LTX 2.3 reference workflow", refEdit, "Use the matched standard/module LoRAs plus the three boolean EditAnything flag placeholders listed below.");
    refField.classList.add("full");
    fields.append(refField);
    fields.insertAdjacentHTML("beforeend", `<div class="full form-help">Available placeholders: {{source_video}}, {{reference_image}}, {{prompt}}, {{seed}}, {{width}}, {{height}}, {{fps}}, {{duration}}, {{frame_count}}, {{ltx_checkpoint}}, {{ltx_distilled_lora}}, {{ltx_inpaint_lora}}, {{ltx_text_encoder}}, {{ltx_spatial_upscaler}}, {{sam_checkpoint}}, {{krea_diffusion_model}}, {{krea_text_encoder}}, {{krea_vae}}, {{krea_edit_lora}}, {{edit_anything_standard_lora}}, {{edit_anything_module_lora}}, {{edit_anything_enable_visual_crossattn}}, {{edit_anything_enable_role_embedding}}, {{edit_anything_enable_adaln}}.</div>`);
}

function openProjectMenu() {
    const modal = openModal("Project", state.project.name);
    modal.body.innerHTML = `<div class="form-stack"><div class="clip-summary"><div class="clip-thumb">▶</div><div><strong>${escapeHtml(state.project.name)}</strong><span>${state.project.width}×${state.project.height} · ${state.project.fps} fps · ${formatClock(projectDuration())}</span></div></div><button class="button primary export-mp4">Export MP4</button><button class="button secondary rename">Rename sequence</button><button class="button secondary add-video">Add video track</button><button class="button secondary add-audio">Add audio track</button><button class="button secondary settings">Project settings</button><button class="button secondary export-json">Export edit list</button></div>`;
    $(".rename", modal.body).onclick = () => {
        const next = prompt("Sequence name", state.project.name);
        if (next?.trim()) { checkpoint(); state.project.name = next.trim(); renderAll(); closeModal(); }
    };
    $(".settings", modal.body).onclick = () => openSettings("project");
    $(".add-video", modal.body).onclick = () => { addTrack("video"); closeModal(); };
    $(".add-audio", modal.body).onclick = () => { addTrack("audio"); closeModal(); };
    $(".export-mp4", modal.body).onclick = exportMp4;
    $(".export-json", modal.body).onclick = exportEditList;
    modalButton(modal, "Close", closeModal);
}

function addTrack(kind) {
    checkpoint();
    const number = state.project.tracks.filter((track) => track.kind === kind).length + 1;
    const track = { id: uid("track"), kind, name: `${kind === "video" ? "Video" : "Audio"} ${number}`, enabled: true, clips: [] };
    if (kind === "video") state.project.tracks.unshift(track);
    else state.project.tracks.push(track);
    renderAll();
}

function exportEditList() {
    const project = structuredClone(state.project);
    for (const media of project.media) {
        delete media.file;
        if (media.url.startsWith("blob:")) media.url = "";
        delete media.poster;
    }
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${state.project.name.replace(/[^a-z0-9_-]+/gi, "-") || "comfy-cut"}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function drawExportFrame(context, entries, time) {
    context.fillStyle = "#050505";
    context.fillRect(0, 0, context.canvas.width, context.canvas.height);
    const active = entries.filter(({ clip }) => time >= clip.start && time < clip.start + clip.duration).sort((a, b) => b.trackIndex - a.trackIndex);
    for (const { clip, element } of active) {
        if (element.readyState < 2) continue;
        const sourceTime = clip.sourceIn + time - clip.start;
        if (Math.abs(element.currentTime - sourceTime) > .15) element.currentTime = clamp(sourceTime, 0, Math.max(0, element.duration - .001));
        if (element.paused) element.play().catch(() => {});
        const transform = clip.transform || defaultTransform();
        const sourceRatio = element.videoWidth / element.videoHeight;
        const targetRatio = context.canvas.width / context.canvas.height;
        let width;
        let height;
        if (sourceRatio > targetRatio) {
            width = context.canvas.width * transform.scale / 100;
            height = width / sourceRatio;
        } else {
            height = context.canvas.height * transform.scale / 100;
            width = height * sourceRatio;
        }
        context.save();
        context.globalAlpha = transform.opacity / 100;
        context.translate(context.canvas.width / 2 + transform.x, context.canvas.height / 2 + transform.y);
        context.rotate(transform.rotation * Math.PI / 180);
        context.drawImage(element, -width / 2, -height / 2, width, height);
        context.restore();
    }
    for (const entry of entries) {
        if (!active.includes(entry) && !entry.element.paused) entry.element.pause();
    }
}

function syncExportAudio(entries, time) {
    for (const { clip, element } of entries) {
        const active = time >= clip.start && time < clip.start + clip.duration;
        if (!active) {
            if (!element.paused) element.pause();
            continue;
        }
        const sourceTime = clip.sourceIn + time - clip.start;
        if (Math.abs(element.currentTime - sourceTime) > .15) element.currentTime = clamp(sourceTime, 0, Math.max(0, element.duration - .001));
        if (element.paused) element.play().catch(() => {});
    }
}

async function exportMp4() {
    const duration = sequenceDuration();
    if (!duration) return toast("Nothing to export", "Add a clip to an enabled track first.", "error");
    if (!state.backend.online) return toast("ComfyUI is offline", "Start ComfyUI before exporting MP4.", "error");
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) return toast("Export is unavailable", "This browser cannot record the timeline canvas.", "error");
    const modal = openModal("Export MP4", state.project.name);
    modal.body.innerHTML = `<div class="job-progress"><span>Preparing timeline media…</span><div class="progress-track"><i></i></div></div><p class="form-help export-help">The editor renders the sequence once in real time, including enabled video and audio tracks, then ComfyUI encodes the recording as H.264 MP4.</p>`;
    const label = $(".job-progress span", modal.body);
    const bar = $(".job-progress i", modal.body);
    let cancelled = false;
    const cancel = modalButton(modal, "Cancel export", () => { cancelled = true; cancel.disabled = true; label.textContent = "Stopping export…"; });
    const exportButton = $("#export-button");
    exportButton.disabled = true;
    let audioContext = null;
    let stream = null;
    const videoEntries = [];
    const audioEntries = [];
    try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (AudioContextClass) {
            audioContext = new AudioContextClass();
            await audioContext.resume();
        }
        for (let trackIndex = 0; trackIndex < state.project.tracks.length; trackIndex++) {
            const track = state.project.tracks[trackIndex];
            if (!track.enabled) continue;
            for (const clip of track.clips) {
                const media = findMedia(clip.mediaId);
                if (!media) continue;
                const element = document.createElement(track.kind === "video" ? "video" : "audio");
                element.src = media.url;
                element.preload = "auto";
                element.playsInline = true;
                if (track.kind === "video") element.muted = true;
                await waitFor(element, "loadeddata");
                const firstFrame = clamp(clip.sourceIn, 0, Math.max(0, element.duration - .001));
                if (Math.abs(element.currentTime - firstFrame) > .001) {
                    element.currentTime = firstFrame;
                    await waitFor(element, "seeked");
                }
                const entry = { clip, element, trackIndex };
                if (track.kind === "video") videoEntries.push(entry);
                else audioEntries.push(entry);
            }
        }
        if (cancelled) return;
        const canvas = document.createElement("canvas");
        canvas.width = state.project.width;
        canvas.height = state.project.height;
        const context = canvas.getContext("2d");
        stream = canvas.captureStream(state.project.fps);
        if (audioContext && audioEntries.length) {
            const destination = audioContext.createMediaStreamDestination();
            for (const { element } of audioEntries) audioContext.createMediaElementSource(element).connect(destination);
            for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);
        }
        const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus") ? "video/webm;codecs=vp9,opus" : "video/webm";
        const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 16_000_000 });
        const chunks = [];
        recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
        const finished = new Promise((resolve, reject) => {
            recorder.onstop = resolve;
            recorder.onerror = () => reject(new Error("The browser could not render this sequence"));
        });
        drawExportFrame(context, videoEntries, 0);
        syncExportAudio(audioEntries, 0);
        const started = performance.now();
        recorder.start(500);
        label.textContent = "Rendering timeline in real time…";
        await new Promise((resolve) => {
            const render = (now) => {
                const time = Math.min(duration, (now - started) / 1000);
                drawExportFrame(context, videoEntries, time);
                syncExportAudio(audioEntries, time);
                bar.style.width = `${Math.max(2, time / duration * 80)}%`;
                if (cancelled || time >= duration) resolve();
                else requestAnimationFrame(render);
            };
            requestAnimationFrame(render);
        });
        [...videoEntries, ...audioEntries].forEach(({ element }) => element.pause());
        recorder.stop();
        await finished;
        if (cancelled) return;
        label.textContent = "Sending local render to ComfyUI for MP4 encoding…";
        bar.style.width = "82%";
        const blob = new Blob(chunks, { type: mimeType });
        const uploaded = await uploadBlob(blob, `comfy-cut-export-${Date.now()}.webm`);
        const prompt = {
            "1": { inputs: { file: annotatedResource(uploaded) }, class_type: "LoadVideo", _meta: { title: "Rendered sequence" } },
            "2": { inputs: { video: ["1", 0], filename_prefix: "video/ComfyCut_export", format: "mp4", codec: "h264" }, class_type: "SaveVideo", _meta: { title: "Export MP4" } },
        };
        const generated = await runPrompt(prompt, { onProgress: (progress, text) => { if (progress != null) bar.style.width = `${82 + progress * 18}%`; if (text) label.textContent = text; } });
        const resource = pickResource(generated.resources, "video");
        if (!resource) throw new Error("ComfyUI finished without an MP4 output");
        const link = document.createElement("a");
        link.href = resourceUrl(resource);
        link.download = `${state.project.name.replace(/[^a-z0-9_-]+/gi, "-") || "comfy-cut"}.mp4`;
        link.click();
        closeModal();
        toast("MP4 exported", "The finished sequence was saved from ComfyUI.");
    } catch (error) {
        if (!cancelled) {
            label.textContent = error.message;
            bar.style.background = "var(--danger)";
            toast("Export failed", error.message, "error");
        }
    } finally {
        [...videoEntries, ...audioEntries].forEach(({ element }) => { element.pause(); element.removeAttribute("src"); });
        stream?.getTracks().forEach((track) => track.stop());
        await audioContext?.close();
        exportButton.disabled = false;
        if (cancelled) closeModal();
    }
}

function openClipMenu() {
    const result = selected();
    if (!result) return;
    const modal = openModal("Clip actions", result.clip.name);
    modal.body.innerHTML = `<div class="form-stack"><button class="button secondary copy">Copy</button><button class="button secondary duplicate">Duplicate</button><button class="button secondary split">Cut at playhead</button><button class="button secondary unlink">${result.clip.linkedId ? "Unlink audio and video" : "No linked clip"}</button><button class="button danger delete">Delete clip</button></div>`;
    $(".copy", modal.body).onclick = () => { copySelection(); closeModal(); };
    $(".duplicate", modal.body).onclick = () => { duplicateSelection(); closeModal(); };
    $(".split", modal.body).onclick = () => { splitClip(); closeModal(); };
    $(".unlink", modal.body).disabled = !result.clip.linkedId;
    $(".unlink", modal.body).onclick = () => {
        checkpoint();
        const linked = findClip(result.clip.linkedId)?.clip;
        if (linked) linked.linkedId = null;
        result.clip.linkedId = null;
        closeModal();
        renderAll();
    };
    $(".delete", modal.body).onclick = () => { deleteSelection(); closeModal(); };
    modalButton(modal, "Cancel", closeModal);
}

function bindEvents() {
    $("#import-button").onclick = chooseVideo;
    $("#media-add").onclick = chooseVideo;
    $("#file-input").onchange = async (event) => {
        try { await importVideo(event.target.files[0]); } catch (error) { toast("Import failed", error.message, "error"); }
        event.target.value = "";
    };
    $("#undo-button").onclick = undo;
    $("#redo-button").onclick = redo;
    $("#split-button").onclick = () => splitClip();
    $("#duplicate-button").onclick = duplicateSelection;
    $("#delete-button").onclick = deleteSelection;
    $("#play-button").onclick = togglePlay;
    $("#previous-frame").onclick = () => setPlayhead(state.playhead - 1 / state.project.fps);
    $("#next-frame").onclick = () => setPlayhead(state.playhead + 1 / state.project.fps);
    $("#fit-button").onclick = () => {
        state.previewZoom = null;
        applyPreviewSize();
    };
    $("#canvas-wrap").onwheel = (event) => {
        event.preventDefault();
        const currentScale = previewCanvas.getBoundingClientRect().width / Math.max(1, previewCanvas.width);
        state.previewZoom = clamp(currentScale * (event.deltaY < 0 ? 1.12 : .89), .03, 4);
        applyPreviewSize();
    };
    $("#settings-button").onclick = () => openSettings();
    $("#export-button").onclick = exportMp4;
    $("#project-button").onclick = openProjectMenu;
    $("#clip-menu").onclick = openClipMenu;
    $("#backend-pill").onclick = checkBackend;
    $("#link-button").onclick = () => {
        state.linkMode = !state.linkMode;
        $("#link-button").classList.toggle("active", state.linkMode);
        $("#link-button").innerHTML = `<span>⛓</span> ${state.linkMode ? "Linked" : "Independent"}`;
    };
    $$('[data-tool]', $(".main-tools")).forEach((button) => button.onclick = () => {
        state.tool = button.dataset.tool;
        $$('[data-tool]', $(".main-tools")).forEach((candidate) => candidate.classList.toggle("active", candidate === button));
        renderTimeline();
    });
    $("#timeline-zoom").oninput = (event) => {
        state.pixelsPerSecond = Number(event.target.value);
        renderTimeline();
    };
    $("#ruler").onpointerdown = startTimelineScrub;
    $("#playhead").onpointerdown = startTimelineScrub;
    $("#ai-tools").onclick = (event) => {
        const action = event.target.closest("button")?.dataset.action;
        if (!action) return;
        ({ sam: openSamMask, "simple-mask": openSimpleMask, inpaint: openInpaint, "image-edit": openImageEdit, i2v: openI2V, "ref-edit": openRefEdit })[action]?.();
    };
    document.addEventListener("keydown", handleKeyboard);
    window.addEventListener("resize", applyPreviewSize);
    window.addEventListener("beforeunload", () => {
        for (const media of state.project.media) if (media.url?.startsWith("blob:")) URL.revokeObjectURL(media.url);
    });
}

function handleKeyboard(event) {
    const typing = event.target.matches("input,textarea,select,[contenteditable=true]");
    if (event.key === "Escape" && state.activeModal) return closeModal();
    if (typing) return;
    const command = event.metaKey || event.ctrlKey;
    if (command && event.key.toLowerCase() === "z") { event.preventDefault(); return event.shiftKey ? redo() : undo(); }
    if (command && event.key.toLowerCase() === "c") { event.preventDefault(); return copySelection(); }
    if (command && event.key.toLowerCase() === "v") { event.preventDefault(); return pasteSelection(); }
    if (command && event.key.toLowerCase() === "d") { event.preventDefault(); return duplicateSelection(); }
    if (command && event.key.toLowerCase() === "x") { event.preventDefault(); copySelection(); return deleteSelection(); }
    if (event.key === " " ) { event.preventDefault(); return togglePlay(); }
    if (event.key === "ArrowLeft") return setPlayhead(state.playhead - 1 / state.project.fps);
    if (event.key === "ArrowRight") return setPlayhead(state.playhead + 1 / state.project.fps);
    if (event.key === "Delete" || event.key === "Backspace") return deleteSelection();
    if (event.key.toLowerCase() === "c") {
        state.tool = "cut";
        $$('[data-tool]', $(".main-tools")).forEach((button) => button.classList.toggle("active", button.dataset.tool === "cut"));
        renderTimeline();
    }
    if (event.key.toLowerCase() === "v") {
        state.tool = "select";
        $$('[data-tool]', $(".main-tools")).forEach((button) => button.classList.toggle("active", button.dataset.tool === "select"));
        renderTimeline();
    }
}

bindEvents();
bindInspector();
updateUndoButtons();
renderAll();
checkBackend();
setInterval(checkBackend, 15000);
