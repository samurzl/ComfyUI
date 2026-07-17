const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const uid = (prefix) => `${prefix}-${crypto.randomUUID()}`;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const roundFrame = (seconds) => Math.round(seconds * state.project.fps) / state.project.fps;
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "mkv", "avi"]);
const PROJECT_INDEX_FILE = "comfy-cut-projects.json";
const LTX_DISTILLATION_PROFILES = {
    distilled: { loraKey: "ltxDistilledLora", strength: .5 },
    dmd: {
        loraKey: "ltxDmdLora",
        strength: 1,
        firstPassSigmas: "1.000, 0.955, 0.893, 0.812, 0.715, 0.603, 0.482, 0.241, 0.121, 0.0",
        upscaleSigmas: "0.92, 0.725, 0.421875, 0.0",
    },
};

function emptyProject(width = 1920, height = 1080, fps = 30) {
    return {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        name: "Untitled sequence",
        width,
        height,
        fps,
        tracks: [
            { id: uid("track"), kind: "video", name: "Video 1", enabled: true, clips: [] },
            { id: uid("track"), kind: "audio", name: "Audio 1", enabled: true, clips: [] },
        ],
        media: [],
    };
}

const defaultSettings = {
    samCheckpoint: "sam3.1_multiplex_fp16.safetensors",
    ltxCheckpoint: "ltx-2.3-22b-dev-fp8.safetensors",
    ltxVaeTileSize: 768,
    ltxDistillationMode: "distilled",
    ltxDistilledLora: "ltx-2.3-22b-distilled-lora-384.safetensors",
    ltxDmdLora: "LTX2.3_DMD_reshaped_r256.safetensors",
    ltxInpaintLora: "ltx-2.3-22b-ic-lora-in-outpainting-0.9.safetensors",
    ltxTextEncoder: "gemma_3_12B_it_fp4_mixed.safetensors",
    ltxSpatialUpscaler: "ltx-2.3-spatial-upscaler-x2-1.1.safetensors",
    kreaDiffusionModel: "",
    kreaTextEncoder: "",
    kreaVae: "",
    kreaEditLora: "",
    kreaGroundingMode: "auto",
    kreaGroundingPx: 768,
    editAnythingLora: "",
    loraLibrary: [],
    projectMegapixels: 2,
    projectWidth: 1920,
    projectHeight: 1080,
    projectFps: 30,
    imageEditWorkflow: "",
};

const state = {
    project: emptyProject(),
    settings: { ...defaultSettings, ...readSettings() },
    backend: { online: false, models: {}, nodeTypes: new Set(), settingsLoaded: false, socket: null, jobs: new Map() },
    selectedClipId: null,
    tool: "select",
    linkMode: true,
    playhead: 0,
    playing: false,
    playStartedAt: 0,
    playStartedFrom: 0,
    pixelsPerSecond: 90,
    snapEnabled: true,
    previewZoom: null,
    clipboard: null,
    projectDirty: false,
    projectSaving: false,
    timelineScrubCleanup: null,
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
        return normalizeSettings(JSON.parse(localStorage.getItem("comfy-cut-settings") || "{}"));
    } catch {
        return {};
    }
}

function normalizeSettings(settings) {
    settings.loraLibrary = Array.isArray(settings.loraLibrary) ? settings.loraLibrary : [];
    if (!LTX_DISTILLATION_PROFILES[settings.ltxDistillationMode]) settings.ltxDistillationMode = "distilled";
    settings.ltxVaeTileSize = ltxVaeTileSize(settings);
    settings.projectMegapixels ||= (Number(settings.projectWidth) || 1920) * (Number(settings.projectHeight) || 1080) / 1_000_000;
    if (!settings.editAnythingLora && /edit_anything_v1\.1/i.test(settings.editAnythingStandardLora || "")) settings.editAnythingLora = settings.editAnythingStandardLora;
    delete settings.kreaCheckpoint;
    delete settings.editAnythingMode;
    delete settings.editAnythingStandardLora;
    delete settings.editAnythingModuleLora;
    delete settings.refEditWorkflow;
    return settings;
}

function ltxVaeTileSize(settings = state.settings) {
    return Math.round(clamp(Number(settings.ltxVaeTileSize) || 768, 64, 4096) / 32) * 32;
}

function ltxVaeTileLayout(width, height, settings = state.settings) {
    const tileSize = ltxVaeTileSize(settings);
    const overlap = tileSize < 256 ? Math.floor(tileSize / 4) : 64;
    const tiles = (length) => length <= tileSize ? 1 : Math.ceil((length - overlap) / (tileSize - overlap));
    const columns = tiles(width);
    const rows = tiles(height);
    return { tileSize, columns, rows, count: columns * rows };
}

function resolutionForMegapixels(megapixels, aspectRatio) {
    const pixels = clamp(Number(megapixels) || 2, .1, 64) * 1_000_000;
    const aspect = Number(aspectRatio) > 0 ? Number(aspectRatio) : 16 / 9;
    let width = Math.max(64, Math.round(Math.sqrt(pixels * aspect) / 32) * 32);
    let height = Math.max(64, Math.round(Math.sqrt(pixels / aspect) / 32) * 32);
    const scale = Math.min(1, 8192 / width, 8192 / height);
    width = Math.max(64, Math.round(width * scale / 32) * 32);
    height = Math.max(64, Math.round(height * scale / 32) * 32);
    return { width, height };
}

function projectAspectRatio() {
    const source = state.project.media[0];
    return source?.width && source?.height ? source.width / source.height : state.project.width / state.project.height;
}

function applyProjectMegapixels(megapixels, aspectRatio = projectAspectRatio()) {
    const resolution = resolutionForMegapixels(megapixels, aspectRatio);
    state.project.width = resolution.width;
    state.project.height = resolution.height;
    state.settings.projectMegapixels = clamp(Number(megapixels) || 2, .1, 64);
    state.settings.projectWidth = resolution.width;
    state.settings.projectHeight = resolution.height;
}

async function saveSettings() {
    localStorage.setItem("comfy-cut-settings", JSON.stringify(state.settings));
    try {
        const response = await apiFetch("/userdata/comfy-cut-settings.json?overwrite=true", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(state.settings),
        });
        return response.ok;
    } catch {
        return false;
    }
}

async function loadPersistedSettings() {
    try {
        const response = await apiFetch("/userdata/comfy-cut-settings.json", { cache: "no-store" });
        if (response.status === 404) {
            state.backend.settingsLoaded = true;
            await saveSettings();
            return;
        }
        if (!response.ok) return;
        const saved = normalizeSettings(await response.json());
        state.settings = { ...defaultSettings, ...saved };
        state.project.width = Number(state.settings.projectWidth) || 1920;
        state.project.height = Number(state.settings.projectHeight) || 1080;
        state.project.fps = Number(state.settings.projectFps) || 30;
        state.project.name = state.settings.projectName || state.project.name;
        localStorage.setItem("comfy-cut-settings", JSON.stringify(state.settings));
        state.backend.settingsLoaded = true;
        renderAll();
    } catch {
        // Browser storage remains the fallback when user-data storage is unavailable.
    }
}

function projectFileName(id) {
    return `comfy-cut-project-${id}.json`;
}

async function readUserJson(filename, fallback = null) {
    const response = await apiFetch(`/userdata/${encodeURIComponent(filename)}`, { cache: "no-store" });
    if (response.status === 404) return fallback;
    if (!response.ok) throw new Error(`Could not read ${filename}`);
    return response.json();
}

async function writeUserJson(filename, value) {
    const response = await apiFetch(`/userdata/${encodeURIComponent(filename)}?overwrite=true`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value),
    });
    if (!response.ok) throw new Error(await response.text() || `Could not write ${filename}`);
}

async function loadProjectIndex() {
    const saved = await readUserJson(PROJECT_INDEX_FILE, { version: 1, projects: [] });
    return Array.isArray(saved?.projects) ? saved.projects : [];
}

function storedProject() {
    return JSON.parse(JSON.stringify(state.project, (key, value) => ["file", "url", "poster"].includes(key) ? undefined : value));
}

function restoreProjectResources(project) {
    if (!project || !Array.isArray(project.tracks) || !Array.isArray(project.media)) throw new Error("This is not a valid Comfy Cut project");
    project.id ||= crypto.randomUUID();
    project.createdAt ||= new Date().toISOString();
    for (const media of project.media) {
        const resource = media.serverRef || media.uploaded;
        if (!resource?.filename) throw new Error(`Saved media is missing for ${media.name || "a clip"}`);
        media.file = null;
        media.uploaded = resource;
        media.serverRef = resource;
        media.url = resourceUrl(resource);
        media.poster = "";
    }
    for (const clip of project.tracks.flatMap((track) => track.clips || [])) {
        for (const image of clip.images || []) if (image.resource) image.url = resourceUrl(image.resource);
        if (clip.mask?.sam?.resource) clip.mask.sam.url = resourceUrl(clip.mask.sam.resource);
    }
    return project;
}

function releaseCurrentProject() {
    state.timelineScrubCleanup?.();
    state.playing = false;
    $("#play-button").textContent = "▶";
    for (const element of state.runtime.values()) {
        element.pause();
        element.remove();
    }
    state.runtime.clear();
    for (const media of state.project.media) if (media.url?.startsWith("blob:")) URL.revokeObjectURL(media.url);
    state.files.clear();
}

function activateProject(project, view = {}) {
    const restored = restoreProjectResources(project);
    releaseCurrentProject();
    state.project = restored;
    state.playhead = clamp(Number(view.playhead) || 0, 0, projectDuration());
    state.selectedClipId = view.selectedClipId && findClip(view.selectedClipId) ? view.selectedClipId : null;
    state.pixelsPerSecond = clamp(Number(view.pixelsPerSecond) || 90, 35, 220);
    state.settings.projectWidth = state.project.width;
    state.settings.projectHeight = state.project.height;
    state.settings.projectMegapixels = state.project.width * state.project.height / 1_000_000;
    state.settings.projectFps = state.project.fps;
    state.undo.length = 0;
    state.redo.length = 0;
    state.clipboard = null;
    state.projectDirty = false;
    $("#timeline-zoom").value = state.pixelsPerSecond;
    updateUndoButtons();
    renderAll();
}

async function saveProject() {
    if (state.projectSaving) return false;
    if (!state.backend.online) {
        toast("ComfyUI is offline", "Start ComfyUI before saving a project.", "error");
        return false;
    }
    const pendingMedia = state.project.media.filter((media) => !media.uploaded && !media.serverRef);
    if (!state.projectDirty && !pendingMedia.length && state.project.updatedAt) {
        toast("Project already saved", "No media or edit data changed since the last save.");
        return true;
    }
    state.projectSaving = true;
    const button = $("#save-button");
    const oldLabel = button.textContent;
    button.disabled = true;
    try {
        for (let index = 0; index < pendingMedia.length; index++) {
            button.textContent = `Uploading media ${index + 1}/${pendingMedia.length}`;
            const media = pendingMedia[index];
            const resource = await ensureMediaUploaded(media);
            media.uploaded = resource;
            media.serverRef = resource;
        }
        button.textContent = "Writing project…";
        const updatedAt = new Date().toISOString();
        state.project.updatedAt = updatedAt;
        const payload = {
            version: 1,
            project: storedProject(),
            view: { playhead: state.playhead, selectedClipId: state.selectedClipId, pixelsPerSecond: state.pixelsPerSecond },
        };
        await writeUserJson(projectFileName(state.project.id), payload);
        const projects = await loadProjectIndex();
        const entry = {
            id: state.project.id,
            name: state.project.name,
            createdAt: state.project.createdAt,
            updatedAt,
            width: state.project.width,
            height: state.project.height,
            fps: state.project.fps,
            duration: sequenceDuration(),
            mediaCount: state.project.media.length,
        };
        const next = [entry, ...projects.filter((project) => project.id !== entry.id)].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
        await writeUserJson(PROJECT_INDEX_FILE, { version: 1, projects: next });
        state.projectDirty = false;
        updateViewerLabels();
        toast("Project saved", `${state.project.name} can now be closed and reopened.`);
        return true;
    } catch (error) {
        toast("Could not save project", error.message, "error");
        return false;
    } finally {
        state.projectSaving = false;
        button.disabled = false;
        button.textContent = oldLabel;
    }
}

async function openSavedProject(id) {
    if (state.projectDirty && !confirm("Discard unsaved changes and open another project?")) return false;
    try {
        const saved = await readUserJson(projectFileName(id));
        if (!saved?.project) throw new Error("The saved project file is missing or invalid");
        activateProject(saved.project, saved.view);
        closeModal();
        toast("Project opened", state.project.name);
        return true;
    } catch (error) {
        toast("Could not open project", error.message, "error");
        return false;
    }
}

function closeProject() {
    if (state.projectDirty && !confirm("Close this project and discard unsaved changes?")) return false;
    releaseCurrentProject();
    state.project = emptyProject(Number(state.settings.projectWidth) || 1920, Number(state.settings.projectHeight) || 1080, Number(state.settings.projectFps) || 30);
    state.selectedClipId = null;
    state.playhead = 0;
    state.undo.length = 0;
    state.redo.length = 0;
    state.clipboard = null;
    state.projectDirty = false;
    closeModal();
    updateUndoButtons();
    renderAll();
    toast("Project closed", "Open a saved project or import a video to start another one.");
    return true;
}

function snapshot() {
    return JSON.stringify({ project: state.project, selectedClipId: state.selectedClipId, playhead: state.playhead }, (key, value) => key === "file" ? undefined : value);
}

function checkpoint(value = snapshot()) {
    state.undo.push(value);
    if (state.undo.length > 50) state.undo.shift();
    state.redo.length = 0;
    state.projectDirty = true;
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
    $("#sequence-title").classList.toggle("dirty", state.projectDirty);
    $("#viewer-resolution").textContent = `${state.project.width} × ${state.project.height} · ${(state.project.width * state.project.height / 1_000_000).toFixed(2)} MP · ${state.project.fps} fps`;
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
    state.timelineScrubCleanup?.();
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const update = (pointerEvent) => setPlayhead(timelinePointerTime(pointerEvent));
    let active = true;
    const cleanup = () => {
        if (!active) return;
        active = false;
        if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", cleanup, true);
        window.removeEventListener("pointercancel", cleanup, true);
        window.removeEventListener("blur", cleanup);
        target.removeEventListener("lostpointercapture", cleanup);
        if (state.timelineScrubCleanup === cleanup) state.timelineScrubCleanup = null;
    };
    const move = (moveEvent) => {
        if (!(moveEvent.buttons & 1)) return cleanup();
        update(moveEvent);
    };
    state.timelineScrubCleanup = cleanup;
    target.setPointerCapture?.(pointerId);
    target.addEventListener("lostpointercapture", cleanup);
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", cleanup, true);
    window.addEventListener("pointercancel", cleanup, true);
    window.addEventListener("blur", cleanup);
    update(event);
}

function clipEdgeTargets(excludedIds) {
    return [0, ...state.project.tracks.flatMap((track) => track.clips.filter((clip) => !excludedIds.has(clip.id)).flatMap((clip) => [clip.start, clip.start + clip.duration]))];
}

function closestSnap(value, targets) {
    if (!state.snapEnabled) return null;
    const threshold = 10 / state.pixelsPerSecond;
    let result = null;
    for (const target of targets) {
        const distance = Math.abs(target - value);
        if (distance <= threshold && (!result || distance < result.distance)) result = { value: target, distance };
    }
    return result;
}

function snapClipStart(start, duration, targets) {
    const startSnap = closestSnap(start, targets);
    const endSnap = closestSnap(start + duration, targets);
    if (!startSnap && !endSnap) return { start, guide: null };
    if (!endSnap || (startSnap && startSnap.distance <= endSnap.distance)) return { start: startSnap.value, guide: startSnap.value };
    return { start: endSnap.value - duration, guide: endSnap.value };
}

function showSnapGuide(time) {
    const guide = $("#snap-guide");
    guide.hidden = time == null;
    if (time != null) guide.style.transform = `translateX(${time * state.pixelsPerSecond}px)`;
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
    const snapTargets = clipEdgeTargets(new Set([clip.id, linked?.id].filter(Boolean)));
    let targetTrack = track;
    element.setPointerCapture(event.pointerId);

    const move = (moveEvent) => {
        const delta = roundFrame((moveEvent.clientX - originX) / state.pixelsPerSecond);
        if (mode === "move") {
            const snapped = snapClipStart(Math.max(0, originStart + delta), clip.duration, snapTargets);
            clip.start = Math.max(0, snapped.start);
            showSnapGuide(snapped.guide);
            if (linked) linked.start = Math.max(0, linkedOrigin.start + (clip.start - originStart));
            const row = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest(".track-row");
            const candidate = row ? findTrack(row.dataset.trackId) : null;
            if (candidate?.kind === track.kind) targetTrack = candidate;
            $$(".track-row").forEach((trackRow) => trackRow.classList.toggle("drop-target", trackRow.dataset.trackId === targetTrack.id && targetTrack !== track));
        } else if (mode === "trim-left") {
            let applied = clamp(delta, -originSourceIn, originDuration - 1 / state.project.fps);
            const snapped = closestSnap(originStart + applied, snapTargets);
            if (snapped) applied = clamp(snapped.value - originStart, -originSourceIn, originDuration - 1 / state.project.fps);
            showSnapGuide(snapped && originStart + applied === snapped.value ? snapped.value : null);
            clip.start = originStart + applied;
            clip.sourceIn = originSourceIn + applied;
            clip.duration = originDuration - applied;
            if (linked) {
                linked.start = linkedOrigin.start + applied;
                linked.sourceIn = linkedOrigin.sourceIn + applied;
                linked.duration = linkedOrigin.duration - applied;
            }
        } else {
            let duration = clamp(originDuration + delta, 1 / state.project.fps, clip.sourceDuration - originSourceIn);
            const snapped = closestSnap(originStart + duration, snapTargets);
            if (snapped) duration = clamp(snapped.value - originStart, 1 / state.project.fps, clip.sourceDuration - originSourceIn);
            showSnapGuide(snapped && originStart + duration === snapped.value ? snapped.value : null);
            clip.duration = duration;
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
        showSnapGuide(null);
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
        applyProjectMegapixels(state.settings.projectMegapixels, media.width / media.height);
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
        chip.className = "asset-chip viewable";
        chip.innerHTML = `<img src="${escapeHtml(image.url)}" alt=""><div><strong>${escapeHtml(image.name)}</strong><small>Frame at ${formatClock(image.sourceTime || 0)}</small></div><button title="Remove image">×</button>`;
        chip.onclick = () => openAttachedImage(clip, image);
        $("button", chip).onclick = (event) => {
            event.stopPropagation();
            checkpoint();
            clip.images = clip.images.filter((candidate) => candidate.id !== image.id);
            renderAll();
        };
        root.append(chip);
    }
    if (!root.children.length) root.innerHTML = '<span class="form-help">Masks and edited frames saved from AI tools appear here.</span>';
}

function openAttachedImage(clip, image) {
    const modal = openModal(image.name, `${clip.name} · frame ${formatClock(image.sourceTime || 0)}`, "wide attached-image-modal");
    modal.body.innerHTML = `<div class="attached-image-preview"><img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.name)}"></div>`;
    modalButton(modal, "Close", closeModal, "primary");
}

function updateAIButtons() {
    const result = selected();
    const videoClip = result?.track.kind === "video" ? result.clip : null;
    const audioClip = result?.track.kind === "audio" ? result.clip : null;
    for (const button of $$("#ai-tools button")) {
        const action = button.dataset.action;
        if (action === "regenerate-video") {
            button.disabled = !videoClip || !state.backend.online;
            continue;
        }
        if (action === "regenerate-audio") {
            button.disabled = !audioClip || !state.backend.online;
            continue;
        }
        const needsBackend = !["simple-mask"].includes(button.dataset.action);
        let disabled = !videoClip || (needsBackend && !state.backend.online);
        if (button.dataset.action === "inpaint" && videoClip && !hasMask(videoClip)) disabled = true;
        if (button.dataset.action === "i2v" && videoClip && !(videoClip.images || []).length) disabled = true;
        button.disabled = disabled;
    }
    const help = $("#ai-help");
    if (!result) help.textContent = "Select a video or audio clip to use AI tools.";
    else if (audioClip && !state.backend.online) help.textContent = "ComfyUI is offline. Start it to regenerate audio.";
    else if (audioClip) help.textContent = "Generate a new audio layer for this range from the composited timeline video, with adjustable context.";
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
        if (!state.backend.settingsLoaded) await loadPersistedSettings();
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
    const nodeErrors = Object.values(queued.node_errors || {});
    if (!response.ok || queued.error || nodeErrors.length) {
        const validation = nodeErrors.flatMap((error) => error.errors || []).map((error) => error.message || error.details).filter(Boolean).join("; ");
        const details = queued.error?.message || queued.error?.details || validation || nodeErrors.map((error) => error.class_type).filter(Boolean).join(", ");
        throw new Error(details || "ComfyUI rejected the workflow");
    }
    if (!queued.prompt_id) throw new Error("ComfyUI did not queue the workflow");
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

function stableGenerationValue(value) {
    if (Array.isArray(value)) return value.map(stableGenerationValue);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.keys(value).sort().filter((key) => !["file", "url", "poster", "generationCache"].includes(key)).map((key) => [key, stableGenerationValue(value[key])]));
}

async function generationKey(kind, values) {
    const data = new TextEncoder().encode(JSON.stringify(stableGenerationValue({ version: 1, kind, values })));
    const digest = await crypto.subtle.digest("SHA-256", data);
    return `${kind}:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function generationSource(clip, includeTransform = true) {
    const media = findMedia(clip.mediaId);
    return {
        media: {
            id: media?.id,
            name: media?.name,
            duration: media?.duration,
            width: media?.width,
            height: media?.height,
            resource: media?.serverRef || media?.uploaded,
            localFile: media?.file ? { name: media.file.name, size: media.file.size, lastModified: media.file.lastModified } : null,
        },
        clip: { sourceIn: clip.sourceIn, duration: clip.duration, transform: includeTransform ? clip.transform : undefined },
    };
}

function videoSequenceSource(start, end) {
    return state.project.tracks.filter((track) => track.kind === "video" && track.enabled).map((track) => ({
        id: track.id,
        clips: track.clips.filter((clip) => rangesOverlap(clip.start, clip.start + clip.duration, start, end)).map((clip) => ({ id: clip.id, start: clip.start, ...generationSource(clip) })),
    }));
}

function generationFormat() {
    return { width: state.project.width, height: state.project.height, fps: state.project.fps };
}

function ltxDistillation(settings = state.settings) {
    const mode = LTX_DISTILLATION_PROFILES[settings.ltxDistillationMode] ? settings.ltxDistillationMode : "distilled";
    const profile = LTX_DISTILLATION_PROFILES[mode];
    return { mode, lora: settings[profile.loraKey], ...profile };
}

function ltxGenerationModels(kind) {
    const distillation = ltxDistillation();
    const models = { checkpoint: state.settings.ltxCheckpoint, distilledLora: distillation.lora, textEncoder: state.settings.ltxTextEncoder, vaeTileSize: ltxVaeTileSize() };
    if (distillation.mode === "dmd") models.distillationMode = "dmd";
    if (kind === "i2v") models.spatialUpscaler = state.settings.ltxSpatialUpscaler;
    if (kind === "inpaint" || kind === "regenerate") models.inpaintLora = state.settings.ltxInpaintLora;
    if (kind === "edit-anything") models.editAnythingLora = state.settings.editAnythingLora;
    return models;
}

function cachedGeneration(clip, key) {
    return clip.generationCache?.find((entry) => entry.key === key)?.resource || null;
}

function rememberGeneration(clip, key, resource) {
    clip.generationCache = [{ key, resource, createdAt: new Date().toISOString() }, ...(clip.generationCache || []).filter((entry) => entry.key !== key)].slice(0, 100);
    state.projectDirty = true;
    updateViewerLabels();
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

async function videoMediaInfo(resource) {
    const response = await apiFetch(`/video-editor/media-info?${new URLSearchParams({ file: annotatedResource(resource) })}`, { cache: "no-store" });
    if (!response.ok) throw new Error("Could not read the source video frame rate");
    const info = await response.json();
    if (!(Number(info.fps) > 0)) throw new Error("The source video has an invalid frame rate");
    return info;
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
        const widgetInputs = (node.inputs || []).filter((input) => input.widget);
        const includesLinkedWidgets = (node.widgets_values?.length || 0) >= widgetInputs.length;
        let widgetIndex = 0;
        for (const input of node.inputs || []) {
            let widgetValue;
            if (input.widget && (input.link == null || includesLinkedWidgets)) widgetValue = node.widgets_values?.[widgetIndex++];
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

function applyLtxDistillation(prompt, loraPredicate) {
    const distillation = ltxDistillation();
    setNodeInput(prompt, loraPredicate, "lora_name", distillation.lora);
    setNodeInput(prompt, loraPredicate, "strength_model", distillation.strength);
    if (distillation.mode !== "dmd") return;
    for (const node of Object.values(prompt)) {
        if (node.class_type !== "ManualSigmas") continue;
        const firstSigma = Number.parseFloat(node.inputs.sigmas);
        node.inputs.sigmas = firstSigma >= .99 ? distillation.firstPassSigmas : distillation.upscaleSigmas;
    }
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

function applyLtxVaeTileSize(prompt) {
    for (const node of Object.values(prompt)) {
        if (node.class_type === "VAEDecodeTiled") node.inputs.tile_size = ltxVaeTileSize();
    }
}

async function buildInpaintPrompt(clip, promptText, seed, maskData, loras = []) {
    requireNodes(["VideoProjectFormat", "VideoInpaintPreprocess", "VideoInpaintPyramidBlend"], "Two-stage LTX inpaint");
    const data = await blueprint("Video Timeline Edit (LTX-2.3).json");
    const { prompt } = graphToPrompt(data.definitions.subgraphs[0]);
    const media = findMedia(clip.mediaId);
    const uploaded = await ensureMediaUploaded(media);
    const fps = state.project.fps;
    const endFrame = Math.max(1, Math.round(clip.duration * fps));
    setNodeInput(prompt, (node) => node.class_type === "LoadVideo", "file", annotatedResource(uploaded));
    setNodeInput(prompt, (node) => node.class_type === "VideoTimeline", "timeline_data", JSON.stringify({ mode: "inpaint", selection_start: 0, selection_end: endFrame, context_before: 0, context_after: 0, mask: maskData }));
    setNodeInput(prompt, (node) => node.class_type === "VideoTimeline", "frame_rate", fps);
    setNodeInput(prompt, (node) => node.class_type === "CheckpointLoaderSimple", "ckpt_name", state.settings.ltxCheckpoint);
    setNodeInput(prompt, nodeTitleIncludes("in/outpainting"), "lora_name", state.settings.ltxInpaintLora);
    setNodeInput(prompt, (node) => node.class_type === "LTXAVTextEncoderLoader", "text_encoder", state.settings.ltxTextEncoder);
    setNodeInput(prompt, (node) => node.class_type === "LTXAVTextEncoderLoader", "ckpt_name", state.settings.ltxCheckpoint);
    setNodeInput(prompt, (node) => node.class_type === "LTXVAudioVAELoader", "ckpt_name", state.settings.ltxCheckpoint);
    setNodeInput(prompt, nodeTitleIncludes("edit prompt"), "value", promptText);
    setNodeInput(prompt, (node) => node.class_type === "RandomNoise", "noise_seed", seed);
    setNodeInput(prompt, (node) => node.class_type === "VideoTimelineApply", "feather", 0);
    setNodeInput(prompt, (node) => node.class_type === "VideoTimelineApply", "frame_rate", fps);
    setNodeInput(prompt, (node) => node.class_type === "SaveVideo", "filename_prefix", "video/ComfyCut_inpaint");

    const loadId = promptNodeId(prompt, (node) => node.class_type === "LoadVideo");
    const timelineId = promptNodeId(prompt, (node) => node.class_type === "VideoTimeline");
    const sourceResizeId = promptNodeId(prompt, nodeTitleIncludes("prepare ltx guide"));
    const sizeId = promptNodeId(prompt, (node) => node.class_type === "GetImageSize");
    const guideId = promptNodeId(prompt, (node) => node.class_type === "LTXVAddGuide");
    const checkpointId = promptNodeId(prompt, (node) => node.class_type === "CheckpointLoaderSimple");
    const modelId = promptNodeId(prompt, nodeTitleIncludes("in/outpainting"));
    const stageOneSamplerId = promptNodeId(prompt, (node) => node.class_type === "SamplerCustomAdvanced");
    const stageOneSeparateId = promptNodeId(prompt, (node) => node.class_type === "LTXVSeparateAVLatent");
    const cropId = promptNodeId(prompt, (node) => node.class_type === "LTXVCropGuides");
    const stageOneDecodeId = promptNodeId(prompt, (node) => node.class_type === "VAEDecodeTiled");
    const timelineApplyId = promptNodeId(prompt, (node) => node.class_type === "VideoTimelineApply");
    const stageOneWidth = Math.max(64, Math.round(state.project.width / 64) * 32);
    const stageOneHeight = Math.max(64, Math.round(state.project.height / 64) * 32);
    const vaeTileSize = ltxVaeTileSize();
    const vaeTileOverlap = Math.min(64, Math.floor(vaeTileSize / 4));

    prompt["8997"] = { inputs: { video: [loadId, 0], start_time: clip.sourceIn, duration: clip.duration, strict_duration: false }, class_type: "Video Slice", _meta: { title: "Trim source before decoding" } };
    prompt["8998"] = { inputs: { video: ["8997", 0], frame_rate: fps, width: state.project.width, height: state.project.height }, class_type: "VideoProjectFormat", _meta: { title: "Project-format source clip" } };
    prompt[timelineId].inputs.video = ["8998", 0];
    prompt[timelineApplyId].inputs.video = ["8998", 0];
    prompt[sourceResizeId].inputs = { input: [timelineId, 0], resize_type: "scale to multiple", "resize_type.multiple": 32, scale_method: "area" };
    prompt["9000"] = { inputs: { input: [sourceResizeId, 0], resize_type: "scale dimensions", "resize_type.width": stageOneWidth, "resize_type.height": stageOneHeight, "resize_type.crop": "disabled", scale_method: "area" }, class_type: "ResizeImageMaskNode", _meta: { title: "Stage 1 half-resolution source" } };
    prompt["9001"] = { inputs: { input: [timelineId, 2], resize_type: "match size", "resize_type.match": ["9000", 0], "resize_type.crop": "disabled", scale_method: "area" }, class_type: "ResizeImageMaskNode", _meta: { title: "Stage 1 mask" } };
    prompt["9002"] = { inputs: { mask: ["9001", 0], expand: 8, tapered_corners: true }, class_type: "GrowMask", _meta: { title: "Stage 1 mask safety margin" } };
    prompt["9003"] = { inputs: { images: ["9000", 0], mask: ["9002", 0] }, class_type: "VideoInpaintPreprocess", _meta: { title: "Stage 1 masked guide" } };
    prompt[sizeId].inputs.image = ["9003", 0];
    prompt[guideId].inputs.image = ["9003", 0];
    prompt[stageOneSeparateId].inputs.av_latent = [stageOneSamplerId, 1];
    prompt["9004"] = { inputs: { generated: [stageOneDecodeId, 0], source: ["9000", 0], mask: ["9002", 0], grow: 0, levels: 5 }, class_type: "VideoInpaintPyramidBlend", _meta: { title: "Stage 1 boundary blend" } };
    prompt["9005"] = { inputs: { input: ["9004", 0], resize_type: "match size", "resize_type.match": [sourceResizeId, 0], "resize_type.crop": "disabled", scale_method: "lanczos" }, class_type: "ResizeImageMaskNode", _meta: { title: "Upscale first pass for refinement" } };
    prompt["9006"] = { inputs: { pixels: ["9005", 0], vae: [checkpointId, 2], tile_size: vaeTileSize, overlap: vaeTileOverlap, temporal_size: 4096, temporal_overlap: 4 }, class_type: "VAEEncodeTiled", _meta: { title: "Encode first pass for refinement" } };
    prompt["9007"] = { inputs: { video_latent: ["9006", 0], audio_latent: [stageOneSeparateId, 1] }, class_type: "LTXVConcatAVLatent", _meta: { title: "Stage 2 AV latent" } };
    prompt["9008"] = { inputs: { noise_seed: seed }, class_type: "RandomNoise", _meta: { title: "Stage 2 noise" } };
    prompt["9009"] = { inputs: { sampler_name: "euler_cfg_pp" }, class_type: "KSamplerSelect", _meta: { title: "Stage 2 sampler" } };
    prompt["9010"] = { inputs: { sigmas: "0.7250, 0.4219, 0.0" }, class_type: "ManualSigmas", _meta: { title: "Stage 2 refinement schedule" } };
    prompt["9011"] = { inputs: { model: [modelId, 0], positive: [cropId, 0], negative: [cropId, 1], cfg: 1 }, class_type: "CFGGuider", _meta: { title: "Stage 2 guider" } };
    prompt["9012"] = { inputs: { noise: ["9008", 0], guider: ["9011", 0], sampler: ["9009", 0], sigmas: ["9010", 0], latent_image: ["9007", 0] }, class_type: "SamplerCustomAdvanced", _meta: { title: "Stage 2 refinement" } };
    prompt["9013"] = { inputs: { av_latent: ["9012", 0] }, class_type: "LTXVSeparateAVLatent", _meta: { title: "Stage 2 video latent" } };
    prompt["9014"] = { inputs: { samples: ["9013", 0], vae: [checkpointId, 2], tile_size: vaeTileSize, overlap: vaeTileOverlap, temporal_size: 4096, temporal_overlap: 4 }, class_type: "VAEDecodeTiled", _meta: { title: "Decode refined video" } };
    prompt["9015"] = { inputs: { generated: ["9014", 0], source: [sourceResizeId, 0], mask: [timelineId, 2], grow: 0, levels: 6 }, class_type: "VideoInpaintPyramidBlend", _meta: { title: "Final inpaint boundary blend" } };
    prompt[timelineApplyId].inputs.edited_images = ["9015", 0];
    prompt[timelineApplyId].inputs.composited = true;
    applyLtxVaeTileSize(prompt);
    applyLtxDistillation(prompt, nodeTitleIncludes("distilled lora"));
    appendGenerationLoras(prompt, loras);
    return prompt;
}

function promptNodeId(prompt, predicate) {
    return Object.entries(prompt).find(([, node]) => predicate(node))?.[0];
}

async function buildTimelineRegenerationPrompt(videoReference, selectionStart, selectionDuration, contextBefore, contextAfter, promptText, seed, kind, loras = []) {
    const data = await blueprint("Video Timeline Edit (LTX-2.3).json");
    const { prompt } = graphToPrompt(data.definitions.subgraphs[0]);
    const fps = state.project.fps;
    const selectionStartFrame = Math.max(0, Math.round(selectionStart * fps));
    const selectionEndFrame = selectionStartFrame + Math.max(1, Math.round(selectionDuration * fps));
    const timelineData = kind === "audio"
        ? { mode: "inpaint", selection_start: selectionStartFrame, selection_end: selectionEndFrame, context_before: contextBefore, context_after: contextAfter, mask: {} }
        : { mode: "regenerate", selection_start: selectionStartFrame, selection_end: selectionEndFrame, context_before: contextBefore, context_after: contextAfter };
    setNodeInput(prompt, (node) => node.class_type === "LoadVideo", "file", annotatedResource(videoReference));
    setNodeInput(prompt, (node) => node.class_type === "VideoTimeline", "timeline_data", JSON.stringify(timelineData));
    setNodeInput(prompt, (node) => node.class_type === "VideoTimeline", "frame_rate", fps);
    setNodeInput(prompt, (node) => node.class_type === "CheckpointLoaderSimple", "ckpt_name", state.settings.ltxCheckpoint);
    setNodeInput(prompt, nodeTitleIncludes("in/outpainting"), "lora_name", state.settings.ltxInpaintLora);
    setNodeInput(prompt, (node) => node.class_type === "LTXAVTextEncoderLoader", "text_encoder", state.settings.ltxTextEncoder);
    setNodeInput(prompt, (node) => node.class_type === "LTXAVTextEncoderLoader", "ckpt_name", state.settings.ltxCheckpoint);
    setNodeInput(prompt, (node) => node.class_type === "LTXVAudioVAELoader", "ckpt_name", state.settings.ltxCheckpoint);
    setNodeInput(prompt, nodeTitleIncludes("edit prompt"), "value", promptText);
    setNodeInput(prompt, (node) => node.class_type === "RandomNoise", "noise_seed", seed);
    setNodeInput(prompt, (node) => node.class_type === "VideoTimelineApply", "feather", 8);
    setNodeInput(prompt, (node) => node.class_type === "VideoTimelineApply", "frame_rate", fps);
    setNodeInput(prompt, (node) => node.class_type === "VideoTimelineApply", "composited", false);
    if (kind === "audio") {
        setNodeInput(prompt, (node) => node.class_type === "LTXVAudioToAudioInplace", "bypass", true);
        for (const [id, node] of Object.entries(prompt)) if (node.class_type === "SaveVideo") delete prompt[id];
        const separateId = promptNodeId(prompt, (node) => node.class_type === "LTXVSeparateAVLatent");
        const audioVaeId = promptNodeId(prompt, (node) => node.class_type === "LTXVAudioVAELoader");
        const timelineId = promptNodeId(prompt, (node) => node.class_type === "VideoTimeline");
        prompt["9100"] = { inputs: { samples: [separateId, 1], audio_vae: [audioVaeId, 0] }, class_type: "LTXVAudioVAEDecode", _meta: { title: "Decode regenerated audio" } };
        prompt["9101"] = { inputs: { images: [timelineId, 0], audio: ["9100", 0], fps: [timelineId, 5] }, class_type: "CreateVideo", _meta: { title: "Composited video with regenerated audio" } };
        prompt["9102"] = { inputs: { video: ["9101", 0], filename_prefix: "video/ComfyCut_regenerated_audio", format: "auto", codec: "auto" }, class_type: "SaveVideo", _meta: { title: "Save regenerated audio" } };
    } else {
        setNodeInput(prompt, (node) => node.class_type === "SaveVideo", "filename_prefix", "video/ComfyCut_regenerated_video");
        applyLtxVaeTileSize(prompt);
    }
    applyLtxDistillation(prompt, nodeTitleIncludes("distilled lora"));
    appendGenerationLoras(prompt, loras);
    return prompt;
}

function buildEditAnythingPrompt(videoReference, clip, promptText, seed, loras = []) {
    const width = Math.max(64, Math.round(state.project.width / 32) * 32);
    const height = Math.max(64, Math.round(state.project.height / 32) * 32);
    const frameCount = Math.ceil((Math.max(1, Math.round(clip.duration * state.project.fps)) - 1) / 8) * 8 + 1;
    const prompt = {
        "1": { inputs: { file: annotatedResource(videoReference) }, class_type: "LoadVideo", _meta: { title: "Selected clip" } },
        "2": { inputs: { video: ["1", 0] }, class_type: "GetVideoComponents", _meta: { title: "Guide video components" } },
        "3": { inputs: { input: ["2", 0], resize_type: "scale to multiple", "resize_type.multiple": 32, scale_method: "area" }, class_type: "ResizeImageMaskNode", _meta: { title: "Prepare guide frames" } },
        "4": { inputs: { ckpt_name: state.settings.ltxCheckpoint }, class_type: "CheckpointLoaderSimple", _meta: { title: "LTX-2.3 base model" } },
        "5": { inputs: { model: ["4", 0], lora_name: state.settings.ltxDistilledLora, strength_model: .5 }, class_type: "LoraLoaderModelOnly", _meta: { title: "LTX-2.3 distilled LoRA" } },
        "6": { inputs: { model: ["5", 0], lora_name: state.settings.editAnythingLora, strength_model: 1 }, class_type: "LoraLoaderModelOnly", _meta: { title: "EditAnything v1.1" } },
        "7": { inputs: { text_encoder: state.settings.ltxTextEncoder, ckpt_name: state.settings.ltxCheckpoint, device: "default" }, class_type: "LTXAVTextEncoderLoader", _meta: { title: "LTX-2.3 text encoder" } },
        "8": { inputs: { clip: ["7", 0], text: promptText }, class_type: "CLIPTextEncode", _meta: { title: "Edit instruction" } },
        "9": { inputs: { clip: ["7", 0], text: "worst quality, blurry, jittery, distorted, duplicate objects" }, class_type: "CLIPTextEncode", _meta: { title: "Negative prompt" } },
        "10": { inputs: { positive: ["8", 0], negative: ["9", 0], frame_rate: state.project.fps }, class_type: "LTXVConditioning", _meta: { title: "LTX conditioning" } },
        "11": { inputs: { width, height, length: frameCount, batch_size: 1 }, class_type: "EmptyLTXVLatentVideo", _meta: { title: "Output video latent" } },
        "12": { inputs: { noise_seed: seed }, class_type: "RandomNoise", _meta: { title: "Generation seed" } },
        "13": { inputs: { sampler_name: "euler_ancestral_cfg_pp" }, class_type: "KSamplerSelect", _meta: { title: "Sampler" } },
        "14": { inputs: { sigmas: "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0" }, class_type: "ManualSigmas", _meta: { title: "LTX distilled schedule" } },
        "15": { inputs: { model: ["6", 0], positive: ["10", 0], negative: ["10", 1], cfg: 1 }, class_type: "CFGGuider", _meta: { title: "EditAnything guider" } },
        "16": { inputs: { model: ["6", 0], vae: ["4", 2], noise: ["12", 0], sampler: ["13", 0], sigmas: ["14", 0], guider: ["15", 0], positive: ["10", 0], negative: ["10", 1], latents: ["11", 0], temporal_tile_size: 80, temporal_overlap: 24, blend_overlap: true, lora_name: "(none)", guide_frames: ["3", 0], guide_strength: 1, enable_ic_lora: true, enable_role_embedding: false, enable_adaln: false, reapply_per_chunk: true, enable_visual_crossattn: false, debug_ea: false }, class_type: "LTXVEditAnythingLoopingSampler", _meta: { title: "EditAnything v1.1 looping sampler" } },
        "17": { inputs: { samples: ["16", 0], vae: ["4", 2], tile_size: ltxVaeTileSize(), overlap: 64, temporal_size: 4096, temporal_overlap: 4 }, class_type: "VAEDecodeTiled", _meta: { title: "Decode edited video" } },
        "18": { inputs: { images: ["17", 0], audio: ["2", 1], fps: state.project.fps }, class_type: "CreateVideo", _meta: { title: "Edited video with source audio" } },
        "19": { inputs: { video: ["18", 0], filename_prefix: "video/ComfyCut_EditAnything_v1_1", format: "auto", codec: "auto" }, class_type: "SaveVideo", _meta: { title: "Save EditAnything result" } },
    };
    applyLtxDistillation(prompt, nodeTitleIncludes("distilled lora"));
    const model = appendModelLoras(prompt, ["6", 0], loras);
    prompt["15"].inputs.model = model;
    prompt["16"].inputs.model = model;
    return prompt;
}

async function buildI2VPrompt(imageReference, clip, promptText, seed, loras = []) {
    const data = await blueprint("Image to Video (LTX-2.3).json");
    const graph = data.definitions.subgraphs[0];
    const width = Math.max(64, Math.round(state.project.width / 32) * 32);
    const height = Math.max(64, Math.round(state.project.height / 32) * 32);
    const duration = Math.max(1, Math.ceil(clip.duration));
    const loadId = "9000";
    const distillation = ltxDistillation();
    const external = [[loadId, 0], promptText, width, height, duration, state.settings.ltxCheckpoint, distillation.lora, state.settings.ltxTextEncoder, state.settings.ltxSpatialUpscaler, Math.round(state.project.fps)];
    const { prompt, resolveLink } = graphToPrompt(graph, external);
    prompt[loadId] = { inputs: { image: annotatedResource(imageReference) }, class_type: "LoadImage", _meta: { title: "Comfy Cut start frame" } };
    const targetFrames = Math.ceil((Math.max(1, Math.round(clip.duration * state.project.fps)) - 1) / 8) * 8 + 1;
    setNodeInput(prompt, (node) => node.class_type === "EmptyLTXVLatentVideo", "length", targetFrames);
    setNodeInput(prompt, (node) => node.class_type === "LTXVEmptyLatentAudio", "frames_number", targetFrames);
    setNodeInput(prompt, (node) => node.class_type === "RandomNoise", "noise_seed", seed);
    const outputLink = graph.outputs[0]?.linkIds?.[0];
    prompt["9001"] = { inputs: { video: resolveLink(outputLink), filename_prefix: "video/ComfyCut_i2v", format: "auto", codec: "auto" }, class_type: "SaveVideo", _meta: { title: "Comfy Cut output" } };
    applyLtxVaeTileSize(prompt);
    applyLtxDistillation(prompt, (node) => node.class_type === "LoraLoaderModelOnly" && node.inputs.lora_name === distillation.lora);
    appendGenerationLoras(prompt, loras);
    return prompt;
}

function samFrameLayout(clip, frameRate) {
    const sourceStartFrame = Math.max(0, Math.floor(clip.sourceIn * frameRate + 1e-6));
    const lastProjectTime = Math.max(0, clip.duration - 1 / state.project.fps);
    const sourceEndFrame = Math.max(sourceStartFrame, Math.floor((clip.sourceIn + lastProjectTime) * frameRate + 1e-6));
    const frameCount = sourceEndFrame - sourceStartFrame + 1;
    return { frameRate, sourceStartFrame, frameCount, startTime: sourceStartFrame / frameRate, duration: frameCount / frameRate };
}

function samMaskFrameIndex(sam, sourceIn, time) {
    const frame = Math.floor((sourceIn + time) * sam.frameRate + 1e-6) - sam.sourceStartFrame;
    return clamp(frame, 0, sam.frames.length - 1);
}

function buildSamPrompt(videoReference, clip, promptText, options, frameRate) {
    const layout = samFrameLayout(clip, frameRate);
    const detectInputs = {
        model: ["3", 0],
        threshold: options.threshold,
        refine_iterations: options.refine,
        individual_masks: false,
    };
    if (promptText.trim()) detectInputs.conditioning = ["4", 0];
    if (options.positive.length) detectInputs.positive_coords = JSON.stringify(options.positive.map(({ x, y }) => ({ x, y })));
    if (options.negative.length) detectInputs.negative_coords = JSON.stringify(options.negative.map(({ x, y }) => ({ x, y })));
    if (options.boxes.length) detectInputs.bboxes = options.boxes;
    const trackInputs = { images: ["9", 0], model: ["3", 0], initial_mask: ["5", 0], detection_threshold: options.threshold, max_objects: 4, detect_interval: 1 };
    if (promptText.trim()) trackInputs.conditioning = ["4", 0];
    return {
        "1": { inputs: { file: annotatedResource(videoReference) }, class_type: "LoadVideo", _meta: { title: "Source clip" } },
        "2": { inputs: { video: ["1", 0], start_time: layout.startTime, duration: layout.duration, strict_duration: false }, class_type: "Video Slice", _meta: { title: "Frame-aligned selected clip" } },
        "9": { inputs: { video: ["2", 0] }, class_type: "GetVideoComponents", _meta: { title: "Video frames" } },
        "3": { inputs: { ckpt_name: state.settings.samCheckpoint }, class_type: "CheckpointLoaderSimple", _meta: { title: "SAM3 model" } },
        "4": { inputs: { clip: ["3", 1], text: promptText || "object" }, class_type: "CLIPTextEncode", _meta: { title: "Object description" } },
        "10": { inputs: { image: ["9", 0], batch_index: 0, length: 1 }, class_type: "ImageFromBatch", _meta: { title: "First frame" } },
        "5": { inputs: { ...detectInputs, image: ["10", 0] }, class_type: "SAM3_Detect", _meta: { title: "Initial SAM3 mask" } },
        "11": { inputs: trackInputs, class_type: "SAM3_VideoTrack", _meta: { title: "Track mask through clip" } },
        "12": { inputs: { track_data: ["11", 0], object_indices: "" }, class_type: "SAM3_TrackToMask", _meta: { title: "Tracked mask" } },
        "6": { inputs: { mask: ["12", 0] }, class_type: "MaskToImage", _meta: { title: "Mask preview" } },
        "13": { inputs: { images: ["6", 0], filename_prefix: "ComfyCut/SAM3_mask_frames" }, class_type: "SaveImage", _meta: { title: "Save exact mask frames" } },
        "7": { inputs: { images: ["6", 0], fps: ["9", 2] }, class_type: "CreateVideo", _meta: { title: "Mask video" } },
        "8": { inputs: { video: ["7", 0], filename_prefix: "video/ComfyCut_SAM3_mask", format: "auto", codec: "auto" }, class_type: "SaveVideo", _meta: { title: "Save mask" } },
    };
}

function kreaGroundingPixels(width, height, settings = state.settings) {
    if (settings.kreaGroundingMode !== "manual") return Math.min(768, Math.max(width, height));
    const grounding = Number(settings.kreaGroundingPx);
    return Number.isFinite(grounding) ? clamp(grounding, 0, 4096) : 768;
}

function buildKreaImageEditPrompt(imageReference, promptText, seed, width, height, loras = []) {
    width = Math.max(64, Math.round(width / 16) * 16);
    height = Math.max(64, Math.round(height / 16) * 16);
    const groundingPx = kreaGroundingPixels(width, height);
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

function stopMedia(root) {
    for (const media of root?.querySelectorAll?.("video, audio") || []) {
        media.pause();
        media.removeAttribute("src");
        media.load();
    }
}

function closeModal() {
    stopMedia(state.activeModal);
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

function bindFrameStepper(modal, clip, seek, getTime) {
    const scrub = $(".frame-scrub", modal.body);
    if (!scrub) return;
    const step = 1 / state.project.fps;
    const max = Math.max(0, clip.duration - step);
    scrub.max = max;
    const controls = document.createElement("div");
    controls.className = "frame-controls";
    controls.innerHTML = `<button class="frame-previous" title="Previous frame">‹</button><output>Frame 1</output><button class="frame-next" title="Next frame">›</button>`;
    scrub.before(controls);
    controls.insertBefore(scrub, $("output", controls));
    const update = (time) => {
        const value = roundFrame(clamp(time, 0, max));
        scrub.value = value;
        $("output", controls).textContent = `Frame ${Math.round(value * state.project.fps) + 1}`;
        return value;
    };
    const move = (direction) => seek(update(getTime() + direction * step));
    $(".frame-previous", controls).onclick = () => move(-1);
    $(".frame-next", controls).onclick = () => move(1);
    scrub.addEventListener("input", () => update(Number(scrub.value)));
    modal.root._frameStep = move;
    update(getTime());
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
    const samImage = new Image();
    let samTime = -1;
    let samFrameIndex = -1;
    const maskOverlay = document.createElement("canvas");
    const editor = await frameEditor(clip, canvas, (context, time) => {
        if (maskOverlay.width !== canvas.width || maskOverlay.height !== canvas.height) {
            maskOverlay.width = canvas.width;
            maskOverlay.height = canvas.height;
        }
        const maskContext = maskOverlay.getContext("2d", { willReadFrequently: true });
        maskContext.clearRect(0, 0, maskOverlay.width, maskOverlay.height);
        const exactMaskReady = working.sam?.frames?.length && samImage.complete && samImage.naturalWidth && samTime === time;
        if (exactMaskReady || (samVideo.src && samVideo.readyState >= 2 && samTime === time)) {
            maskContext.drawImage(exactMaskReady ? samImage : samVideo, 0, 0, maskOverlay.width, maskOverlay.height);
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
    let seeking = false;
    const seek = async (time) => {
        requestedTime = roundFrame(clamp(time, 0, Math.max(0, clip.duration - 1 / state.project.fps)));
        $(".frame-scrub", modal.body).value = requestedTime;
        updateTimeline();
        if (seeking) return;
        seeking = true;
        try {
            while (editor.time !== requestedTime || ((working.sam?.frames?.length || samVideo.src) && samTime !== requestedTime)) {
                const target = requestedTime;
                await editor.seek(target);
                if (working.sam?.frames?.length) {
                    const frameIndex = samMaskFrameIndex(working.sam, clip.sourceIn, target);
                    if (frameIndex !== samFrameIndex) {
                        await new Promise((resolve, reject) => {
                            samImage.onload = resolve;
                            samImage.onerror = () => reject(new Error("Could not decode the SAM3 mask frame"));
                            samImage.src = resourceUrl(working.sam.frames[frameIndex]);
                        });
                        samFrameIndex = frameIndex;
                    }
                    samTime = target;
                    editor.draw();
                } else if (samVideo.src) {
                    const sourceTime = clamp((working.sam?.trimmed ? working.sam.offset || 0 : clip.sourceIn) + target, 0, Math.max(0, samVideo.duration - .001));
                    if (Math.abs(samVideo.currentTime - sourceTime) > .001) {
                        samVideo.currentTime = sourceTime;
                        await waitFor(samVideo, "seeked");
                    }
                    samTime = target;
                    editor.draw();
                }
            }
        } finally {
            seeking = false;
        }
    };
    if (!working.sam?.frames?.length && working.sam?.url) {
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
    bindFrameStepper(modal, clip, seek, () => editor.time);
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
    try {
        requireNodes(["SAM3_Detect", "SAM3_VideoTrack", "SAM3_TrackToMask"], "SAM3 mask");
    } catch (error) {
        toast("SAM3 tracking nodes are missing", error.message, "error");
        return;
    }
    const existing = structuredClone(clip.mask || { sam: null, shapes: [], corrections: [], morphology: 0 });
    existing.corrections ||= [];
    const options = {
        positive: structuredClone(existing.sam?.positive || []).map((point) => ({ ...point, time: 0 })),
        negative: structuredClone(existing.sam?.negative || []).map((point) => ({ ...point, time: 0 })),
        boxes: structuredClone(existing.sam?.boxes || []),
        threshold: existing.sam?.threshold ?? .5,
        refine: existing.sam?.refine ?? 2,
    };
    const modal = openModal("SAM3 mask", clip.name, "mask-modal");
    modal.body.innerHTML = `<div class="modal-grid"><div><div class="mask-toolbar"><button data-tool="positive" class="active">＋ Point</button><button data-tool="negative">− Point</button><button data-tool="box">□ Box</button><button data-tool="brush">Brush</button><button data-tool="erase">Erase</button><button data-action="clear-prompts">Clear prompts</button></div><div class="modal-preview"><canvas></canvas></div><input class="frame-scrub" type="range" min="0" max="${clip.duration}" step="${1 / state.project.fps}" value="0"></div><div class="form-stack"><label class="form-field"><span>What should SAM3 select?</span><textarea class="sam-prompt" placeholder="e.g. the person in the red jacket">${escapeHtml(existing.sam?.prompt || "")}</textarea></label><label class="form-field"><span>Detection threshold</span><input class="sam-threshold" type="range" min="0.05" max="0.95" step="0.01" value="${options.threshold}"></label><label class="form-field"><span>Refinement passes</span><input class="sam-refine" type="number" min="0" max="5" value="${options.refine}"></label><label class="form-field"><span>Brush size</span><input class="brush-size" type="range" min="0.002" max="0.12" step="0.002" value="0.025"></label><div class="segmented"><button data-morph="-1">Contract</button><button data-morph="0" class="active">Original</button><button data-morph="1">Expand</button></div><button class="button primary auto-segment">✦ Auto-segment with SAM3</button><div class="job-slot"></div><small class="form-help">Text, points, and boxes seed frame 1; SAM3 tracks that mask through the clip. Use Left/Right anywhere in this window to step, paint, and continue without refocusing the timeline.</small></div></div>`;
    const canvas = $("canvas", modal.body);
    const overlayVideo = document.createElement("video");
    overlayVideo.muted = true;
    overlayVideo.preload = "auto";
    const overlayImage = new Image();
    let tool = "positive";
    let boxStart = null;
    let boxDraft = null;
    let stroke = null;
    let overlayTime = -1;
    let overlayFrameIndex = -1;
    const maskOverlay = document.createElement("canvas");
    const editor = await frameEditor(clip, canvas, (context, time) => {
        if (maskOverlay.width !== canvas.width || maskOverlay.height !== canvas.height) {
            maskOverlay.width = canvas.width;
            maskOverlay.height = canvas.height;
        }
        const maskContext = maskOverlay.getContext("2d", { willReadFrequently: true });
        maskContext.clearRect(0, 0, maskOverlay.width, maskOverlay.height);
        const exactMaskReady = existing.sam?.frames?.length && overlayImage.complete && overlayImage.naturalWidth && overlayTime === time;
        if (exactMaskReady || (overlayVideo.src && overlayVideo.readyState >= 2 && overlayTime === time)) {
            maskContext.drawImage(exactMaskReady ? overlayImage : overlayVideo, 0, 0, maskOverlay.width, maskOverlay.height);
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

    let requestedTime = 0;
    let seeking = false;
    const seekBoth = async (time) => {
        requestedTime = roundFrame(clamp(time, 0, Math.max(0, clip.duration - 1 / state.project.fps)));
        $(".frame-scrub", modal.body).value = requestedTime;
        if (seeking) return;
        seeking = true;
        try {
            while (editor.time !== requestedTime || ((existing.sam?.frames?.length || overlayVideo.src) && overlayTime !== requestedTime)) {
                const target = requestedTime;
                await editor.seek(target);
                if (existing.sam?.frames?.length) {
                    const frameIndex = samMaskFrameIndex(existing.sam, clip.sourceIn, target);
                    if (frameIndex !== overlayFrameIndex) {
                        await new Promise((resolve, reject) => {
                            overlayImage.onload = resolve;
                            overlayImage.onerror = () => reject(new Error("Could not decode the SAM3 mask frame"));
                            overlayImage.src = resourceUrl(existing.sam.frames[frameIndex]);
                        });
                        overlayFrameIndex = frameIndex;
                    }
                    overlayTime = target;
                    editor.draw();
                } else if (overlayVideo.src) {
                    const sourceTime = clamp((existing.sam?.trimmed ? existing.sam.offset || 0 : clip.sourceIn) + target, 0, Math.max(0, overlayVideo.duration - .001));
                    if (Math.abs(overlayVideo.currentTime - sourceTime) > .001) {
                        overlayVideo.currentTime = sourceTime;
                        await waitFor(overlayVideo, "seeked");
                    }
                    overlayTime = target;
                    editor.draw();
                }
            }
        } finally {
            seeking = false;
        }
    };
    if (existing.sam?.frames?.length) {
        await seekBoth(0);
    } else if (existing.sam?.url) {
        overlayVideo.src = existing.sam.url;
        await waitFor(overlayVideo, "loadedmetadata");
        await seekBoth(0);
    }
    const setTool = (next) => {
        tool = next;
        $$('[data-tool]', modal.body).forEach((button) => button.classList.toggle("active", button.dataset.tool === next));
        if (["positive", "negative", "box"].includes(next)) seekBoth(0);
    };
    $$('[data-tool]', modal.body).forEach((button) => button.onclick = () => setTool(button.dataset.tool));
    $(".frame-scrub", modal.body).oninput = (event) => seekBoth(Number(event.target.value));
    bindFrameStepper(modal, clip, seekBoth, () => editor.time);
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
            options[tool].push({ x: Math.round(point.x * canvas.width), y: Math.round(point.y * canvas.height), time: 0 });
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
            const samOptions = { ...options, threshold: Number($(".sam-threshold", modal.body).value), refine: Number($(".sam-refine", modal.body).value) };
            const media = findMedia(clip.mediaId);
            const reference = await ensureMediaUploaded(media);
            const mediaInfo = await videoMediaInfo(reference);
            media.fps = Number(mediaInfo.fps);
            const layout = samFrameLayout(clip, media.fps);
            const key = await generationKey("sam3-track-v2", { source: generationSource(clip, false), promptText, options: samOptions, checkpoint: state.settings.samCheckpoint, frameRate: media.fps, layout });
            let maskOutput = cachedGeneration(clip, key);
            const reused = Boolean(maskOutput?.video && maskOutput?.frames?.length);
            if (!reused) {
                const workflow = buildSamPrompt(reference, clip, promptText, samOptions, media.fps);
                const result = await runPrompt(workflow, job.callbacks);
                const video = pickResource(result.resources, "video");
                const frames = result.resources.filter((resource) => ["png", "jpg", "jpeg", "webp"].includes(resource.filename.split(".").pop().toLowerCase()));
                if (!video) throw new Error("SAM3 finished without a mask video output");
                if (frames.length !== layout.frameCount) throw new Error(`SAM3 returned ${frames.length} mask frames; expected ${layout.frameCount}`);
                maskOutput = { video, frames, frameRate: media.fps, sourceStartFrame: layout.sourceStartFrame };
                rememberGeneration(clip, key, maskOutput);
            }
            existing.sam = { prompt: promptText, ...options, threshold: Number($(".sam-threshold", modal.body).value), refine: Number($(".sam-refine", modal.body).value), trackerVersion: 2, resource: maskOutput.video, url: resourceUrl(maskOutput.video), frames: maskOutput.frames, frameRate: maskOutput.frameRate, sourceStartFrame: maskOutput.sourceStartFrame, trimmed: true, offset: 0 };
            overlayVideo.removeAttribute("src");
            overlayVideo.load();
            overlayTime = -1;
            overlayFrameIndex = -1;
            await seekBoth(editor.time);
            job.complete(reused ? "Reused cached result — no model nodes ran" : "SAM3 tracked mask ready");
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

async function makeMaskAtlas(clip, onProgress = () => {}, padToLtx = false, firstFrame = null) {
    if (!hasMask(clip)) throw new Error("This clip has no mask");
    const media = findMedia(clip.mediaId);
    const sourceFrameCount = Math.max(1, Math.round(clip.duration * state.project.fps));
    const frameCount = padToLtx ? Math.ceil((sourceFrameCount - 1) / 8) * 8 + 1 : sourceFrameCount;
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
    const maskImage = new Image();
    let maskFrameIndex = -1;
    if (!clip.mask.sam?.frames?.length && clip.mask.sam?.url) {
        maskVideo.src = clip.mask.sam.url;
        maskVideo.muted = true;
        maskVideo.preload = "auto";
        await waitFor(maskVideo, "loadeddata");
    }
    const frames = [];
    firstFrame ??= Math.round(clip.sourceIn * state.project.fps);
    const lastMaskTime = Math.max(0, (clip.maskSource?.duration ?? clip.duration) - 1 / state.project.fps);
    for (let index = 0; index < frameCount; index++) {
        const sourceIndex = Math.min(index, sourceFrameCount - 1);
        const time = clamp(roundFrame(clip.maskSource?.frameTimes?.[sourceIndex] ?? sourceIndex / state.project.fps), 0, lastMaskTime);
        tileContext.clearRect(0, 0, tileWidth, tileHeight);
        maskContext.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
        const sourceIn = clip.maskSource?.sourceIn ?? clip.sourceIn;
        if (clip.mask.sam?.frames?.length) {
            const frameIndex = samMaskFrameIndex(clip.mask.sam, sourceIn, time);
            if (frameIndex !== maskFrameIndex) {
                await new Promise((resolve, reject) => {
                    maskImage.onload = resolve;
                    maskImage.onerror = () => reject(new Error("Could not decode the SAM3 mask frame"));
                    maskImage.src = resourceUrl(clip.mask.sam.frames[frameIndex]);
                });
                maskFrameIndex = frameIndex;
            }
            maskContext.drawImage(maskImage, 0, 0, maskCanvas.width, maskCanvas.height);
            binarizeMask(maskCanvas);
        } else if (maskVideo.src) {
            const target = clamp((clip.mask.sam?.trimmed ? clip.mask.sam.offset || 0 : sourceIn) + time, 0, Math.max(0, maskVideo.duration - .001));
            if (Math.abs(maskVideo.currentTime - target) > .001) {
                maskVideo.currentTime = target;
                await waitFor(maskVideo, "seeked");
            }
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

async function bakeClip(clip, onProgress = () => {}, includeTransform = true, padToLtx = false) {
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
    const stream = canvas.captureStream(0);
    const frameTrack = stream.getVideoTracks()[0];
    if (!frameTrack?.requestFrame) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error("This browser cannot bake frame-synchronized video clips");
    }
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
    const transform = includeTransform ? clip.transform || defaultTransform() : defaultTransform();
    const sourceFrames = Math.max(1, Math.round(clip.duration * state.project.fps));
    const targetFrames = padToLtx ? Math.ceil((sourceFrames - 1) / 8) * 8 + 1 : sourceFrames;
    const bakedDuration = targetFrames / state.project.fps;
    const frameTimes = [];
    const drawFrame = () => {
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
    };
    let capturedFrames = 0;
    const captureFrame = () => {
        if (capturedFrames < sourceFrames) drawFrame();
        const time = capturedFrames < sourceFrames ? video.currentTime - clip.sourceIn : frameTimes.at(-1);
        frameTimes.push(clamp(time || 0, 0, Math.max(0, clip.duration - 1 / state.project.fps)));
        frameTrack.requestFrame();
        capturedFrames++;
    };
    drawFrame();
    recorder.start(500);
    captureFrame();
    await video.play();
    const started = performance.now();
    await new Promise((resolve) => {
        const draw = () => {
            const elapsed = (performance.now() - started) / 1000;
            const dueFrames = Math.min(targetFrames, Math.floor(elapsed * state.project.fps + 1e-6) + 1);
            while (capturedFrames < dueFrames) captureFrame();
            onProgress(clamp(elapsed / bakedDuration, 0, .99), includeTransform ? "Baking clip transforms in real time…" : "Scaling clip to the project resolution in real time…");
            if (elapsed >= bakedDuration) resolve();
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
    const temporaryMedia = { id: uid("render"), name: "Transformed clip", url: URL.createObjectURL(blob), file: blob, uploaded, serverRef: uploaded, duration: bakedDuration, width: state.project.width, height: state.project.height };
    const temporaryClip = { ...structuredClone(clip), mediaId: temporaryMedia.id, sourceIn: 0, duration: bakedDuration, sourceDuration: bakedDuration, transform: defaultTransform(), maskSource: { mediaId: clip.mediaId, sourceIn: clip.sourceIn, duration: clip.duration, frameTimes, transform: structuredClone(transform) } };
    state.project.media.push(temporaryMedia);
    return { clip: temporaryClip, media: temporaryMedia, cleanup: () => {
        state.project.media = state.project.media.filter((item) => item.id !== temporaryMedia.id);
        URL.revokeObjectURL(temporaryMedia.url);
    } };
}

async function openTimelineRegeneration(kind) {
    const result = selected();
    if (!result || result.track.kind !== kind || !state.backend.online) return;
    const clip = result.clip;
    const title = kind === "audio" ? "Generate audio layer" : "Regenerate video";
    const modal = openModal(title, clip.name, "wide");
    modal.body.innerHTML = `<div class="modal-grid"><div class="generation-preview result-preview"><span class="generation-empty">The enabled video tracks will be composited across this clip and its context.</span></div><div class="form-stack"><label class="form-field"><span>Prompt</span><textarea class="prompt" placeholder="${kind === "audio" ? "Describe the desired dialogue, ambience, music, and sound effects" : "Describe what should happen in the regenerated video interval"}"></textarea></label><label class="form-field"><span>Seed</span><input class="seed" type="number" min="0" max="9007199254740991" value="${randomSeed()}"></label><div class="context-fields"><label class="form-field"><span>Context before</span><span class="field-with-unit"><input class="context-before" type="number" min="0" max="30" step="0.1" value="1"><i>s</i></span></label><label class="form-field"><span>Context after</span><span class="field-with-unit"><input class="context-after" type="number" min="0" max="30" step="0.1" value="1"><i>s</i></span></label></div><small class="form-help">Context is generated with the selected interval so motion and sound can flow across both boundaries. Only the selected clip duration is placed on the timeline.${kind === "audio" ? " The original audio remains untouched; this result is added on another audio track." : ""}</small><button class="button primary generate">Generate ${kind}</button><div class="job-slot"></div></div></div>`;
    const controls = $(".form-stack", modal.body);
    const selectedLoras = generationLoraPicker(controls, "ltx");
    const preview = $(".result-preview", modal.body);
    const generate = $(".generate", modal.body);
    let output = null;
    let generatedSourceIn = 0;
    generate.onclick = async () => {
        const promptText = $(".prompt", modal.body).value.trim();
        if (!promptText) return toast(`Add a ${kind} prompt`, `Describe the ${kind} you want LTX to generate.`, "error");
        const contextBefore = clamp(Number($(".context-before", modal.body).value) || 0, 0, 30);
        const contextAfter = clamp(Number($(".context-after", modal.body).value) || 0, 0, 30);
        const rangeStart = Math.max(0, clip.start - contextBefore);
        const actualBefore = clip.start - rangeStart;
        const layoutPadding = 16 / state.project.fps;
        const rangeEnd = clip.start + clip.duration + contextAfter + layoutPadding;
        const job = generationStatus($(".job-slot", modal.body));
        generate.disabled = true;
        output = null;
        try {
            const seed = Number($(".seed", modal.body).value);
            const loras = selectedLoras();
            const key = await generationKey(`regenerate-${kind}-project-fps-v2`, { selectedClip: { id: clip.id, start: clip.start, duration: clip.duration }, sequence: videoSequenceSource(rangeStart, rangeEnd), promptText, seed, contextBefore: actualBefore, contextAfter, format: generationFormat(), models: ltxGenerationModels("regenerate"), loras });
            output = cachedGeneration(clip, key);
            if (output) {
                generatedSourceIn = actualBefore;
                showJobVideo(preview, resourceUrl(output), generatedSourceIn, clip.duration);
                job.complete("Reused cached result — no model nodes ran");
                return;
            }
            const compositeVideo = await renderCompositeRange(rangeStart, rangeEnd, job.callbacks.onProgress);
            const uploaded = await uploadBlob(compositeVideo, `composited-${kind}-${Date.now()}.webm`);
            job.callbacks.onProgress(.38, "Preparing LTX timeline regeneration…");
            const prompt = await buildTimelineRegenerationPrompt(uploaded, actualBefore, clip.duration, actualBefore, contextAfter, promptText, seed, kind, loras);
            const generated = await runPrompt(prompt, {
                ...job.callbacks,
                onProgress: (progress, text) => job.callbacks.onProgress(progress == null ? null : .4 + progress * .6, text),
            });
            const resource = pickResource(generated.resources, "video");
            if (!resource) throw new Error(`LTX completed without a regenerated ${kind} output`);
            output = resource;
            rememberGeneration(clip, key, output);
            generatedSourceIn = actualBefore;
            showJobVideo(preview, resourceUrl(resource), generatedSourceIn, clip.duration);
            job.complete(kind === "audio" ? "New audio layer ready" : "Video regeneration ready");
        } catch (error) {
            job.fail(error);
        } finally {
            generate.disabled = false;
        }
    };
    modalButton(modal, "Cancel", closeModal);
    modalButton(modal, "Save to timeline", async () => {
        if (!output) return toast(`Generate ${kind} first`, "Preview a result before saving it.", "error");
        await addGeneratedClip(output, clip, generatedSourceIn, title, kind);
        closeModal();
    }, "primary");
}

async function openInpaint() {
    const result = selected();
    if (!result || result.track.kind !== "video" || !hasMask(result.clip)) return;
    const sourceClip = result.clip;
    const modal = openModal("Inpaint", sourceClip.name, "wide");
    modal.body.innerHTML = `<div class="modal-grid"><div class="generation-preview source-preview"></div><div class="form-stack"><label class="form-field"><span>Prompt</span><textarea class="prompt" placeholder="Describe what should replace the masked area"></textarea></label><label class="form-field"><span>Seed</span><input class="seed" type="number" min="0" max="9007199254740991" value="${randomSeed()}"></label><label class="toggle-row"><span>Use clip scale, position, and rotation</span><input class="use-transform" type="checkbox"></label><small class="form-help">Generation always uses the project megapixel resolution. Enable transforms to bake scale, position, and rotation too; empty canvas areas then become outpainting regions.</small><button class="button primary generate">Generate</button><div class="job-slot"></div></div></div>`;
    const selectedLoras = generationLoraPicker($(".form-stack", modal.body), "ltx");
    let output = null;
    const generatedSourceIn = 0;
    const generate = $(".generate", modal.body);
    const jobSlot = $(".job-slot", modal.body);
    const preview = $(".generation-preview", modal.body);
    showJobVideo(preview, findMedia(sourceClip.mediaId).url, sourceClip.sourceIn, sourceClip.duration, true);
    generate.onclick = async () => {
        const promptText = $(".prompt", modal.body).value.trim();
        if (!promptText) return toast("Add an inpaint prompt", "Describe the intended result.", "error");
        generate.disabled = true;
        const job = generationStatus(jobSlot);
        let baked = null;
        try {
            const useTransform = $(".use-transform", modal.body).checked;
            const seed = Number($(".seed", modal.body).value);
            const loras = selectedLoras();
            const key = await generationKey("inpaint-trim-before-resample-v9", { source: generationSource(sourceClip, useTransform), mask: sourceClip.mask, useTransform, promptText, seed, format: generationFormat(), models: ltxGenerationModels("inpaint"), loras });
            output = cachedGeneration(sourceClip, key);
            if (output) {
                showJobVideo(preview, resourceUrl(output), generatedSourceIn, sourceClip.duration);
                job.complete("Reused cached result — no model nodes ran");
                return;
            }
            const clip = useTransform ? (baked = await bakeClip(sourceClip, job.callbacks.onProgress, true, true)).clip : sourceClip;
            if (useTransform) clip.mask = structuredClone(sourceClip.mask);
            const atlas = await makeMaskAtlas(clip, job.callbacks.onProgress, true, 0);
            const workflow = await buildInpaintPrompt(clip, promptText, seed, atlas, loras);
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
            rememberGeneration(sourceClip, key, output);
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
        stopMedia(preview);
        preview.innerHTML = "";
        image = document.createElement("img");
        preview.append(image);
    }
    image.src = url;
}

function showJobVideo(preview, url, start = 0, duration = null, muted = false) {
    stopMedia(preview);
    preview.innerHTML = `<video src="${escapeHtml(url)}" controls autoplay playsinline ${muted ? "muted" : ""}></video>`;
    const video = $("video", preview);
    video.onloadedmetadata = () => {
        video.currentTime = clamp(start, 0, Math.max(0, video.duration - .001));
        video.play().catch(() => {});
    };
    video.ontimeupdate = () => {
        if (duration != null && video.currentTime >= start + duration) video.currentTime = start;
    };
}

async function addGeneratedClip(resource, sourceClip, sourceIn, label, kind = "video") {
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
    const indexes = kind === "video"
        ? Array.from({ length: Math.max(0, originalIndex) }, (_, offset) => originalIndex - offset - 1)
        : Array.from({ length: Math.max(0, state.project.tracks.length - originalIndex - 1) }, (_, offset) => originalIndex + offset + 1);
    for (const index of indexes) {
        const candidate = state.project.tracks[index];
        if (candidate.kind === kind && !candidate.clips.some((clip) => rangesOverlap(clip.start, clip.start + clip.duration, sourceClip.start, sourceClip.start + sourceClip.duration))) {
            target = candidate;
            break;
        }
    }
    if (!target) {
        const name = `${kind === "video" ? "Video" : "Audio"} ${state.project.tracks.filter((track) => track.kind === kind).length + 1}`;
        target = { id: uid("track"), kind, name, enabled: true, clips: [] };
        if (kind === "video") state.project.tracks.unshift(target);
        else state.project.tracks.push(target);
    }
    const clip = {
        id: uid("clip"), mediaId: media.id, name: media.name, start: sourceClip.start, duration: sourceClip.duration,
        sourceIn, sourceDuration: media.duration, linkedId: null, transform: kind === "video" ? defaultTransform() : null, mask: null, images: [], generated: true,
    };
    target.clips.push(clip);
    state.selectedClipId = clip.id;
    renderAll();
    toast("Added to timeline", kind === "video" ? `${label} was placed above the source clip.` : `${label} was placed on a free audio track.`);
}

function rangesOverlap(startA, endA, startB, endB) {
    return startA < endB && startB < endA;
}

async function openImageEdit() {
    const result = selected();
    if (!result || result.track.kind !== "video") return;
    const clip = result.clip;
    const media = findMedia(clip.mediaId);
    const modal = openModal("Image edit", clip.name, "wide image-edit-modal");
    modal.body.innerHTML = `<div class="modal-grid"><div><div class="image-edit-previews"><div class="generation-preview frame-preview"><canvas></canvas></div><div class="generation-preview result-preview" hidden></div></div><input class="frame-scrub" type="range" min="0" max="${clip.duration}" step="${1 / state.project.fps}" value="0"></div><div class="form-stack"><label class="form-field"><span>Prompt</span><textarea class="prompt" placeholder="Describe how this frame should change"></textarea></label><label class="form-field"><span>Seed</span><input class="seed" type="number" value="${randomSeed()}"></label><small class="form-help">Output: ${state.project.width} × ${state.project.height} · grounding: ${kreaGroundingPixels(state.project.width, state.project.height)} px${state.settings.kreaGroundingMode === "manual" ? " manual" : " automatic"}.</small><button class="button primary generate">Generate with Krea 2 Edit</button><div class="job-slot"></div></div></div>`;
    const canvas = $("canvas", modal.body);
    const editor = await frameEditor(clip, canvas);
    const selectedLoras = generationLoraPicker($(".form-stack", modal.body), "krea");
    $(".frame-scrub", modal.body).oninput = (event) => editor.seek(Number(event.target.value));
    bindFrameStepper(modal, clip, editor.seek, () => editor.time);
    let output = null;
    $(".generate", modal.body).onclick = async () => {
        const promptText = $(".prompt", modal.body).value.trim();
        if (!promptText) return toast("Add an edit prompt", "Describe how the chosen frame should change.", "error");
        if (!state.settings.imageEditWorkflow.trim() && (!state.settings.kreaDiffusionModel || !state.settings.kreaTextEncoder || !state.settings.kreaVae || !state.settings.kreaEditLora)) {
            return toast("Complete the Krea 2 setup", "Choose the diffusion model, Qwen3-VL encoder, VAE, and edit LoRA in Settings → Models.", "error");
        }
        const job = generationStatus($(".job-slot", modal.body));
        try {
            const seed = Number($(".seed", modal.body).value);
            const loras = selectedLoras();
            const key = await generationKey("image-edit", { source: generationSource(clip, false), frameTime: editor.time, promptText, seed, format: { width: state.project.width, height: state.project.height }, models: { diffusion: state.settings.kreaDiffusionModel, textEncoder: state.settings.kreaTextEncoder, vae: state.settings.kreaVae, editLora: state.settings.kreaEditLora, grounding: kreaGroundingPixels(state.project.width, state.project.height), workflow: state.settings.imageEditWorkflow }, loras });
            const cached = cachedGeneration(clip, key);
            if (cached) {
                output = { resource: cached, url: resourceUrl(cached), time: editor.time };
                const resultPreview = $(".result-preview", modal.body);
                resultPreview.hidden = false;
                resultPreview.innerHTML = `<img src="${escapeHtml(output.url)}" alt="Generated edit">`;
                $(".image-edit-previews", modal.body).classList.add("has-result");
                job.complete("Reused cached result — no model nodes ran");
                return;
            }
            const blob = await imageBlobAt(clip, editor.time);
            const reference = await uploadBlob(blob, `frame-${Date.now()}.png`);
            const values = workflowValues({ clip, prompt: promptText, seed, sourceImage: reference, referenceImage: reference });
            let workflow;
            if (state.settings.imageEditWorkflow.trim()) {
                workflow = customWorkflow(state.settings.imageEditWorkflow, values);
                appendGenerationLoras(workflow, loras);
            } else {
                requireNodes(["Krea2EditModelPatch", "Krea2EditGroundedEncode"], "Krea 2 image edit");
                workflow = buildKreaImageEditPrompt(reference, promptText, values.seed, state.project.width, state.project.height, loras);
            }
            const generated = await runPrompt(workflow, job.callbacks);
            const resource = pickResource(generated.resources, "image");
            if (!resource) throw new Error("The image edit workflow completed without an image output");
            rememberGeneration(clip, key, resource);
            output = { resource, url: resourceUrl(resource), time: editor.time };
            const resultPreview = $(".result-preview", modal.body);
            resultPreview.hidden = false;
            resultPreview.innerHTML = `<img src="${escapeHtml(output.url)}" alt="Generated edit">`;
            $(".image-edit-previews", modal.body).classList.add("has-result");
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
        toast("Image attached", "It is now available for image-to-video generation.");
    }, "primary");
}

function workflowValues({ clip, prompt, seed, sourceImage, referenceImage }) {
    const distillation = ltxDistillation();
    return {
        prompt,
        seed,
        source_image: sourceImage ? annotatedResource(sourceImage) : "",
        reference_image: referenceImage ? annotatedResource(referenceImage) : "",
        width: state.project.width,
        height: state.project.height,
        fps: state.project.fps,
        duration: clip.duration,
        frame_count: Math.ceil((Math.round(clip.duration * state.project.fps) - 1) / 8) * 8 + 1,
        ltx_checkpoint: state.settings.ltxCheckpoint,
        ltx_distilled_lora: state.settings.ltxDistilledLora,
        ltx_dmd_lora: state.settings.ltxDmdLora,
        ltx_distillation_mode: distillation.mode,
        ltx_distillation_lora: distillation.lora,
        ltx_inpaint_lora: state.settings.ltxInpaintLora,
        ltx_text_encoder: state.settings.ltxTextEncoder,
        ltx_spatial_upscaler: state.settings.ltxSpatialUpscaler,
        krea_diffusion_model: state.settings.kreaDiffusionModel,
        krea_text_encoder: state.settings.kreaTextEncoder,
        krea_vae: state.settings.kreaVae,
        krea_edit_lora: state.settings.kreaEditLora,
        krea_grounding_px: kreaGroundingPixels(state.project.width, state.project.height),
        edit_anything_lora: state.settings.editAnythingLora,
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
            job.complete(job.reused ? "Reused cached result — no model nodes ran" : "Generation ready");
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
        const key = await generationKey("i2v", { duration: clip.duration, image: { id: image.id, resource: image.resource }, promptText, seed, format: generationFormat(), models: ltxGenerationModels("i2v"), loras });
        const cached = cachedGeneration(clip, key);
        if (cached) {
            job.reused = true;
            return cached;
        }
        const workflow = await buildI2VPrompt(image.resource, clip, promptText, seed, loras);
        const generated = await runPrompt(workflow, job.callbacks);
        const resource = pickResource(generated.resources, "video");
        if (!resource) throw new Error("The I2V workflow completed without a video output");
        rememberGeneration(clip, key, resource);
        return resource;
    });
}

async function openEditAnything() {
    const result = selected();
    if (!result || result.track.kind !== "video") return;
    const clip = result.clip;
    if (!state.settings.editAnythingLora) {
        toast("Complete the EditAnything setup", "Select edit_anything_v1.1_r256.safetensors in Settings → Models.", "error");
        openSettings("models");
        return;
    }
    try {
        requireNodes(["LTXVEditAnythingLoopingSampler"], "EditAnything v1.1");
    } catch (error) {
        toast("EditAnything nodes are missing", error.message, "error");
        return;
    }
    const modal = openModal("EditAnything v1.1", clip.name, "wide");
    modal.body.innerHTML = `<div class="modal-grid"><div class="generation-preview result-preview"><span class="generation-empty">The selected clip will be scaled to the project resolution and used as the guide video.</span></div><div class="form-stack"><label class="form-field"><span>Edit instruction</span><textarea class="prompt" placeholder="Replace the blue robot on the left with a smiling man wearing sunglasses."></textarea></label><label class="form-field"><span>Seed</span><input class="seed" type="number" min="0" max="9007199254740991" value="${randomSeed()}"></label><small class="form-help">v1.1 is prompt-only: no attached reference image or module file is used. Use one imperative Add, Remove, Replace, or Style instruction.</small><button class="button primary generate">Generate edit</button><div class="job-slot"></div></div></div>`;
    const controls = $(".form-stack", modal.body);
    const selectedLoras = generationLoraPicker(controls, "ltx");
    const preview = $(".result-preview", modal.body);
    let output = null;
    $(".generate", controls).onclick = async () => {
        const promptText = $(".prompt", controls).value.trim();
        if (!promptText) return toast("Add an edit instruction", "Describe one Add, Remove, Replace, or Style edit.", "error");
        const job = generationStatus($(".job-slot", controls));
        let baked = null;
        try {
            const seed = Number($(".seed", controls).value);
            const loras = selectedLoras();
            const key = await generationKey("edit-anything-v1.1-project-fps-v2", { source: generationSource(clip, false), promptText, seed, format: generationFormat(), models: ltxGenerationModels("edit-anything"), loras });
            output = cachedGeneration(clip, key);
            if (output) {
                showJobVideo(preview, resourceUrl(output), 0, clip.duration);
                job.complete("Reused cached result — no model nodes ran");
                return;
            }
            baked = await bakeClip(clip, job.callbacks.onProgress, false, true);
            const workflow = buildEditAnythingPrompt(baked.media.uploaded, baked.clip, promptText, seed, loras);
            const generated = await runPrompt(workflow, job.callbacks);
            output = pickResource(generated.resources, "video");
            if (!output) throw new Error("The EditAnything workflow completed without a video output");
            rememberGeneration(clip, key, output);
            showJobVideo(preview, resourceUrl(output), 0, clip.duration);
            job.complete("EditAnything result ready");
        } catch (error) {
            job.fail(error);
        } finally {
            baked?.cleanup();
        }
    };
    modalButton(modal, "Cancel", closeModal);
    modalButton(modal, "Save to timeline", async () => {
        if (!output) return toast("Generate an edit first", "Preview a result before saving it.", "error");
        await addGeneratedClip(output, clip, 0, "EditAnything v1.1");
        closeModal();
    }, "primary");
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
    modalButton(modal, "Save settings", async () => {
        const resolution = resolutionForMegapixels(draft.projectMegapixels, projectAspectRatio());
        const fps = clamp(Number(draft.projectFps) || 30, 1, 120);
        const name = draft.projectName || "Untitled sequence";
        if (resolution.width !== state.project.width || resolution.height !== state.project.height || fps !== state.project.fps || name !== state.project.name) checkpoint();
        state.settings = draft;
        applyProjectMegapixels(draft.projectMegapixels);
        state.project.fps = fps;
        state.project.name = name;
        const savedToComfyUI = await saveSettings();
        closeModal();
        renderAll();
        toast("Settings saved", savedToComfyUI ? "Stored in ComfyUI user data for future restarts." : "Stored in this browser; ComfyUI user-data storage was unavailable.");
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
    const distillationMode = document.createElement("select");
    distillationMode.innerHTML = '<option value="distilled">Lightricks distilled</option><option value="dmd">DMD distilled</option>';
    distillationMode.value = draft.ltxDistillationMode;
    distillationMode.onchange = () => draft.ltxDistillationMode = distillationMode.value;
    fields.append(field("LTX sampling profile", distillationMode, "DMD loads its LoRA at strength 1.0 and automatically uses its recommended first-pass and upscale schedules."));
    modelInput(fields, draft, "Lightricks distilled LoRA", "ltxDistilledLora", "loras");
    modelInput(fields, draft, "DMD distilled LoRA", "ltxDmdLora", "loras", "Use LTX2.3_DMD_reshaped_r256.safetensors.");
    modelInput(fields, draft, "In/Outpaint IC-LoRA", "ltxInpaintLora", "loras");
    modelInput(fields, draft, "LTX text encoder", "ltxTextEncoder", "text_encoders");
    modelInput(fields, draft, "LTX spatial upscaler", "ltxSpatialUpscaler", "latent_upscale_models");
    modelInput(fields, draft, "Krea 2 Turbo FP8 diffusion model", "kreaDiffusionModel", "diffusion_models", "The original Turbo FP8 file belongs in models/diffusion_models, not checkpoints.");
    modelInput(fields, draft, "Krea 2 Qwen3-VL text encoder", "kreaTextEncoder", "text_encoders");
    modelInput(fields, draft, "Krea 2 VAE", "kreaVae", "vae", "Usually qwen_image_vae.safetensors.");
    modelInput(fields, draft, "Krea 2 Edit LoRA", "kreaEditLora", "loras", "The edit LoRA is applied before the source-latent patch.");
    const groundingMode = document.createElement("select");
    groundingMode.innerHTML = '<option value="auto">Automatic · source-aware 768 px cap</option><option value="manual">Manual override</option>';
    groundingMode.value = draft.kreaGroundingMode || "auto";
    const grounding = input("number", draft.kreaGroundingPx ?? 768, { min: 0, max: 4096, step: 64 });
    grounding.oninput = () => draft.kreaGroundingPx = Number(grounding.value);
    const updateGrounding = () => {
        draft.kreaGroundingMode = groundingMode.value;
        grounding.disabled = groundingMode.value !== "manual";
    };
    groundingMode.onchange = updateGrounding;
    fields.append(field("Krea grounding", groundingMode, `Automatic uses ${kreaGroundingPixels(draft.projectWidth || state.project.width, draft.projectHeight || state.project.height, { ...draft, kreaGroundingMode: "auto" })} px for this project. This controls Qwen3-VL semantic detail, not output resolution.`));
    fields.append(field("Manual grounding pixels", grounding, "Lower values strengthen broad edits; higher values favor identity detail but can duplicate subjects. v1.1 was trained mostly at 384–768 px; 0 keeps the input's native size."));
    modelInput(fields, draft, "EditAnything v1.1 LoRA", "editAnythingLora", "loras", "Use edit_anything_v1.1_r256.safetensors. It is a normal prompt-only LoRA with no .module companion.");
    fields.insertAdjacentHTML("beforeend", '<div class="full form-help model-note"><strong>Required custom nodes:</strong> Krea image edit needs <a href="https://github.com/lbouaraba/comfyui-krea2edit" target="_blank" rel="noreferrer">ComfyUI-Krea2Edit</a>. EditAnything v1.1 needs the Looping Sampler from <a href="https://github.com/alisson-anjos/ComfyUI-BFSNodes" target="_blank" rel="noreferrer">ComfyUI-BFSNodes</a>. Download <strong>krea2_identity_edit_v1_1.safetensors</strong> from <a href="https://huggingface.co/conradlocke/krea2-identity-edit/tree/main" target="_blank" rel="noreferrer">Krea 2 Identity Edit</a> and <strong>edit_anything_v1.1_r256.safetensors</strong> from <a href="https://huggingface.co/Alissonerdx/EditAnything/tree/main" target="_blank" rel="noreferrer">EditAnything</a>; place both in <strong>models/loras</strong>. The editor never downloads models or calls a hosted API.</div>');
    updateGrounding();
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
    root.innerHTML = `<h3>Project format</h3><p>Set one pixel budget for generation, compositing, and export. The editor preserves the first source video's aspect ratio and rounds dimensions to a model-friendly multiple of 32.</p><div class="settings-fields"></div>`;
    const fields = $(".settings-fields", root);
    const aspect = projectAspectRatio();
    const megapixels = input("number", Number(draft.projectMegapixels || 2).toFixed(2), { min: .1, max: 64, step: .1 });
    const vaeTileSize = input("number", ltxVaeTileSize(draft), { min: 64, max: 4096, step: 32 });
    const resolution = document.createElement("div");
    resolution.className = "full form-help model-note";
    const updateResolution = () => {
        draft.projectMegapixels = clamp(Number(megapixels.value) || 2, .1, 64);
        const size = resolutionForMegapixels(draft.projectMegapixels, aspect);
        draft.projectWidth = size.width;
        draft.projectHeight = size.height;
        const layout = ltxVaeTileLayout(size.width, size.height, draft);
        const tileWarning = layout.count > 1 ? `<br><strong>⚠ LTX final VAE decode will use ${layout.columns} × ${layout.rows} = ${layout.count} overlapping ${layout.tileSize}px tiles.</strong> Increase the tile size above if VRAM allows.` : "";
        resolution.innerHTML = `<strong>${size.width} × ${size.height}</strong> · ${(size.width * size.height / 1_000_000).toFixed(2)} MP actual · source aspect ${aspect.toFixed(4)}:1${draft.projectMegapixels > 1.5 ? "<br>Krea Identity Edit v1.1 recommends about 1–1.5 MP and a 2 MP ceiling; larger projects use more VRAM and may reduce edit quality." : ""}${tileWarning}`;
    };
    megapixels.oninput = updateResolution;
    vaeTileSize.oninput = () => {
        draft.ltxVaeTileSize = Number(vaeTileSize.value);
        updateResolution();
    };
    vaeTileSize.onchange = () => {
        draft.ltxVaeTileSize = ltxVaeTileSize(draft);
        vaeTileSize.value = draft.ltxVaeTileSize;
        updateResolution();
    };
    fields.append(field("Resolution", megapixels, "Megapixels; applies to preview, AI generation, compositing, and MP4 export."));
    fields.append(field("LTX VAE decode tile size", vaeTileSize, "Output pixels per spatial tile. Larger tiles reduce overlap and decode time but use more VRAM."));
    const fps = input("number", draft.projectFps, { min: 1, max: 120, step: 1 });
    fps.oninput = () => draft.projectFps = Number(fps.value);
    fields.append(field("Frame rate", fps));
    fields.append(resolution);
    const name = input("text", draft.projectName);
    name.oninput = () => draft.projectName = name.value;
    const wrapper = field("Sequence name", name);
    wrapper.classList.add("full");
    fields.append(wrapper);
    updateResolution();
}

function renderWorkflowSettings(root, draft) {
    root.innerHTML = `<h3>Advanced workflow overrides</h3><p>Inpaint, I2V, SAM3, Krea, and EditAnything v1.1 use local graphs assembled by the editor. You can optionally override only the Krea image-edit graph.</p><div class="settings-fields"></div>`;
    const fields = $(".settings-fields", root);
    const imageEdit = textarea(draft.imageEditWorkflow || "", '{ "1": { "class_type": "LoadImage", "inputs": { "image": "{{source_image}}" } } }');
    imageEdit.className = "advanced-workflow";
    imageEdit.oninput = () => draft.imageEditWorkflow = imageEdit.value;
    const imageField = field("Image edit API workflow (optional)", imageEdit, "Use {{source_image}}, {{prompt}}, {{seed}}, {{krea_diffusion_model}}, {{krea_text_encoder}}, {{krea_vae}}, {{krea_edit_lora}}, and {{krea_grounding_px}} placeholders.");
    imageField.classList.add("full");
    fields.append(imageField);
    fields.insertAdjacentHTML("beforeend", `<div class="full form-help">Available placeholders: {{source_image}}, {{reference_image}}, {{prompt}}, {{seed}}, {{width}}, {{height}}, {{fps}}, {{duration}}, {{frame_count}}, {{krea_diffusion_model}}, {{krea_text_encoder}}, {{krea_vae}}, {{krea_edit_lora}}, and {{krea_grounding_px}}.</div>`);
}

function savedProjectDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Unknown date" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

async function deleteSavedProject(id) {
    if (id === state.project.id || !confirm("Permanently delete this saved project? The stored media files will be left untouched.")) return false;
    try {
        const response = await apiFetch(`/userdata/${encodeURIComponent(projectFileName(id))}`, { method: "DELETE" });
        if (!response.ok && response.status !== 404) throw new Error(await response.text() || "Could not delete the project file");
        const projects = (await loadProjectIndex()).filter((project) => project.id !== id);
        await writeUserJson(PROJECT_INDEX_FILE, { version: 1, projects });
        toast("Project deleted");
        return true;
    } catch (error) {
        toast("Could not delete project", error.message, "error");
        return false;
    }
}

async function openProjectLibrary() {
    if (!state.backend.online) return toast("ComfyUI is offline", "Start ComfyUI to open saved projects.", "error");
    const modal = openModal("Open project", "Saved in ComfyUI user data", "wide");
    modal.body.innerHTML = '<div class="saved-project-list"><div class="saved-project-empty">Loading saved projects…</div></div>';
    const list = $(".saved-project-list", modal.body);
    const renderProjects = async () => {
        try {
            const projects = await loadProjectIndex();
            list.innerHTML = projects.length ? "" : '<div class="saved-project-empty">No saved projects yet. Import a video, edit it, then press Save.</div>';
            for (const project of projects) {
                const row = document.createElement("div");
                row.className = "saved-project-row";
                row.innerHTML = `<button class="saved-project-open"><span class="saved-project-icon">▶</span><span><strong>${escapeHtml(project.name || "Untitled sequence")}${project.id === state.project.id ? " · open" : ""}</strong><span>${project.width || 0}×${project.height || 0} · ${project.fps || 0} fps · ${formatClock(project.duration || 0)} · ${project.mediaCount || 0} media<br>${escapeHtml(savedProjectDate(project.updatedAt))}</span></span></button><button class="saved-project-delete" title="Delete saved project" ${project.id === state.project.id ? "disabled" : ""}>×</button>`;
                $(".saved-project-open", row).onclick = () => openSavedProject(project.id);
                $(".saved-project-delete", row).onclick = async () => {
                    if (await deleteSavedProject(project.id)) renderProjects();
                };
                list.append(row);
            }
        } catch (error) {
            list.innerHTML = `<div class="saved-project-empty">${escapeHtml(error.message)}</div>`;
        }
    };
    modalButton(modal, "Cancel", closeModal);
    modalButton(modal, "New empty project", closeProject, "secondary");
    await renderProjects();
}

function openProjectMenu() {
    const modal = openModal("Project", state.project.name);
    const saveStatus = state.projectDirty ? "unsaved changes" : state.project.updatedAt ? "saved" : "not saved";
    modal.body.innerHTML = `<div class="form-stack"><div class="clip-summary"><div class="clip-thumb">▶</div><div><strong>${escapeHtml(state.project.name)}</strong><span>${state.project.width}×${state.project.height} · ${(state.project.width * state.project.height / 1_000_000).toFixed(2)} MP · ${state.project.fps} fps · ${formatClock(projectDuration())} · ${saveStatus}</span></div></div><button class="button primary save-project">Save project</button><button class="button secondary open-project">Open saved project</button><button class="button secondary export-mp4">Export MP4</button><button class="button secondary rename">Rename sequence</button><button class="button secondary add-video">Add video track</button><button class="button secondary add-audio">Add audio track</button><button class="button secondary settings">Project settings</button><button class="button secondary export-json">Export edit list</button><button class="button danger close-project">Close project</button></div>`;
    $(".rename", modal.body).onclick = () => {
        const next = prompt("Sequence name", state.project.name);
        if (next?.trim()) { checkpoint(); state.project.name = next.trim(); renderAll(); closeModal(); }
    };
    $(".settings", modal.body).onclick = () => openSettings("project");
    $(".add-video", modal.body).onclick = () => { addTrack("video"); closeModal(); };
    $(".add-audio", modal.body).onclick = () => { addTrack("audio"); closeModal(); };
    $(".save-project", modal.body).onclick = async () => { if (await saveProject()) closeModal(); };
    $(".open-project", modal.body).onclick = openProjectLibrary;
    $(".export-mp4", modal.body).onclick = exportMp4;
    $(".export-json", modal.body).onclick = exportEditList;
    $(".close-project", modal.body).onclick = closeProject;
    modalButton(modal, "Done", closeModal);
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

async function renderCompositeRange(start, end, onProgress = () => {}) {
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) throw new Error("This browser cannot render a composited video range");
    const duration = Math.max(1 / state.project.fps, end - start);
    const entries = [];
    let stream = null;
    try {
        for (let trackIndex = 0; trackIndex < state.project.tracks.length; trackIndex++) {
            const track = state.project.tracks[trackIndex];
            if (!track.enabled || track.kind !== "video") continue;
            for (const clip of track.clips) {
                if (clip.start >= end || clip.start + clip.duration <= start) continue;
                const media = findMedia(clip.mediaId);
                if (!media) continue;
                const element = document.createElement("video");
                element.src = media.url;
                element.preload = "auto";
                element.playsInline = true;
                element.muted = true;
                await waitFor(element, "loadeddata");
                const firstFrame = clamp(clip.sourceIn + Math.max(0, start - clip.start), 0, Math.max(0, element.duration - .001));
                if (Math.abs(element.currentTime - firstFrame) > .001) {
                    element.currentTime = firstFrame;
                    await waitFor(element, "seeked");
                }
                entries.push({ clip, element, trackIndex });
            }
        }
        if (!entries.length) throw new Error("There is no enabled video under this timeline range");
        const canvas = document.createElement("canvas");
        canvas.width = state.project.width;
        canvas.height = state.project.height;
        const context = canvas.getContext("2d");
        stream = canvas.captureStream(state.project.fps);
        const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm";
        const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 12_000_000 });
        const chunks = [];
        recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
        const finished = new Promise((resolve, reject) => {
            recorder.onstop = resolve;
            recorder.onerror = () => reject(new Error("Could not render the composited video range"));
        });
        drawExportFrame(context, entries, start);
        const started = performance.now();
        recorder.start(500);
        await new Promise((resolve) => {
            const render = (now) => {
                const elapsed = Math.min(duration, (now - started) / 1000);
                drawExportFrame(context, entries, start + elapsed);
                onProgress(Math.min(.35, elapsed / duration * .35), "Rendering composited video context in real time…");
                if (elapsed >= duration) resolve();
                else requestAnimationFrame(render);
            };
            requestAnimationFrame(render);
        });
        entries.forEach(({ element }) => element.pause());
        recorder.stop();
        await finished;
        return new Blob(chunks, { type: mimeType });
    } finally {
        entries.forEach(({ element }) => { element.pause(); element.removeAttribute("src"); });
        stream?.getTracks().forEach((track) => track.stop());
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
    $("#snap-button").onclick = () => {
        state.snapEnabled = !state.snapEnabled;
        $("#snap-button").classList.toggle("active", state.snapEnabled);
        $("#snap-button").title = `Clip snapping ${state.snapEnabled ? "on" : "off"}`;
        showSnapGuide(null);
    };
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
    $("#open-button").onclick = openProjectLibrary;
    $("#save-button").onclick = saveProject;
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
        ({ sam: openSamMask, "simple-mask": openSimpleMask, inpaint: openInpaint, "image-edit": openImageEdit, i2v: openI2V, "edit-anything": openEditAnything, "regenerate-video": () => openTimelineRegeneration("video"), "regenerate-audio": () => openTimelineRegeneration("audio") })[action]?.();
    };
    document.addEventListener("keydown", handleKeyboard);
    window.addEventListener("resize", applyPreviewSize);
    window.addEventListener("beforeunload", (event) => {
        if (!state.projectDirty) return;
        event.preventDefault();
        event.returnValue = "";
    });
    window.addEventListener("pagehide", () => {
        for (const media of state.project.media) if (media.url?.startsWith("blob:")) URL.revokeObjectURL(media.url);
    });
}

function handleKeyboard(event) {
    const typing = event.target.matches("input,textarea,select,[contenteditable=true]");
    if (event.key === "Escape" && state.activeModal) return closeModal();
    if (typing) return;
    if (state.activeModal?._frameStep && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        event.preventDefault();
        return state.activeModal._frameStep(event.key === "ArrowLeft" ? -1 : 1);
    }
    const command = event.metaKey || event.ctrlKey;
    if (command && event.key.toLowerCase() === "s") { event.preventDefault(); return saveProject(); }
    if (command && event.key.toLowerCase() === "o") { event.preventDefault(); return openProjectLibrary(); }
    if (command && event.key.toLowerCase() === "z") { event.preventDefault(); return event.shiftKey ? redo() : undo(); }
    if (command && event.key.toLowerCase() === "c") { event.preventDefault(); return copySelection(); }
    if (command && event.key.toLowerCase() === "v") { event.preventDefault(); return pasteSelection(); }
    if (command && event.key.toLowerCase() === "d") { event.preventDefault(); return duplicateSelection(); }
    if (command && event.key.toLowerCase() === "x") { event.preventDefault(); copySelection(); return deleteSelection(); }
    if (event.key === " " ) { event.preventDefault(); return togglePlay(); }
    if (event.key === "ArrowLeft") { event.preventDefault(); return setPlayhead(state.playhead - 1 / state.project.fps); }
    if (event.key === "ArrowRight") { event.preventDefault(); return setPlayhead(state.playhead + 1 / state.project.fps); }
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
