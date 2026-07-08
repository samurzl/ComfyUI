import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const STYLE_ID = "comfy-video-timeline-style";

function addStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
        .video-timeline-backdrop { position: fixed; inset: 0; z-index: 10000; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.8); }
        .video-timeline-editor { width: min(94vw, 1280px); max-height: 95vh; overflow: auto; padding: 16px; border: 1px solid #555; border-radius: 10px; background: #202020; color: #eee; box-shadow: 0 20px 70px #000; }
        .video-timeline-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 9px 0; }
        .video-timeline-editor button, .video-timeline-editor input { color: inherit; background: #333; border: 1px solid #666; border-radius: 5px; padding: 6px 9px; }
        .video-timeline-editor button.active { background: #315b88; border-color: #72b4fa; }
        .video-timeline-stage { position: relative; width: fit-content; max-width: 100%; margin: 10px auto; line-height: 0; background: #000; }
        .video-timeline-stage canvas { display: block; max-width: 90vw; max-height: 55vh; width: auto; height: auto; }
        .video-timeline-stage canvas + canvas { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; cursor: crosshair; }
        .video-timeline-lanes { position: relative; height: 114px; margin: 10px 0; overflow: hidden; border: 1px solid #555; border-radius: 6px; background: #111; touch-action: none; }
        .video-timeline-lane { position: absolute; left: 72px; right: 0; }
        .video-timeline-lane canvas { width: 100%; height: 100%; display: block; }
        .video-timeline-video { top: 0; height: 68px; }
        .video-timeline-audio { top: 69px; height: 44px; border-top: 1px solid #444; }
        .video-timeline-label { position: absolute; left: 0; width: 72px; padding: 6px 8px; color: #aaa; font-size: 11px; box-sizing: border-box; }
        .video-timeline-label.audio { top: 69px; }
        .video-timeline-selection { position: absolute; top: 0; bottom: 0; border: 2px solid #69b7ff; background: rgba(58,136,205,.12); box-shadow: 0 0 0 2000px rgba(0,0,0,.45); cursor: grab; box-sizing: border-box; }
        .video-timeline-selection::before, .video-timeline-selection::after { content: ""; position: absolute; top: -2px; bottom: -2px; width: 9px; background: #69b7ff; cursor: ew-resize; }
        .video-timeline-selection::before { left: -5px; } .video-timeline-selection::after { right: -5px; }
        .video-timeline-context { position: absolute; top: 0; bottom: 0; border: 1px dashed #70d18a; pointer-events: none; box-sizing: border-box; }
        .video-timeline-playhead { position: absolute; top: 0; bottom: 0; width: 2px; background: #ffcf4a; pointer-events: none; }
        .video-timeline-spacer { flex: 1; }
        .video-timeline-hint { color: #bbb; font-size: 12px; }
        .video-timeline-time { min-width: 220px; text-align: center; font-variant-numeric: tabular-nums; }
        .video-timeline-context-input { width: 70px; }
    `;
    document.head.appendChild(style);
}

function resourceUrl(record) {
    return api.apiURL(`/view?${new URLSearchParams(record)}`);
}

function annotatedFileUrl(file) {
    const match = /^(.*?)(?: \[(input|output|temp)\])?$/.exec(file);
    const path = match?.[1] ?? file;
    const type = match?.[2] ?? "input";
    const slash = path.lastIndexOf("/");
    return api.apiURL(`/view?${new URLSearchParams({
        filename: slash < 0 ? path : path.slice(slash + 1),
        subfolder: slash < 0 ? "" : path.slice(0, slash),
        type,
    })}`);
}

function loadImage(url) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("Could not load saved timeline masks"));
        image.src = url;
    });
}

function loadVideo(url) {
    return new Promise((resolve, reject) => {
        const video = document.createElement("video");
        video.preload = "auto";
        video.playsInline = true;
        video.onloadedmetadata = () => resolve(video);
        video.onerror = () => reject(new Error("Could not load video preview"));
        video.src = url;
    });
}

function seekVideo(video, time) {
    const target = Math.min(Math.max(time, 0), Math.max(0, video.duration - 0.0001));
    if (video.readyState >= 2 && Math.abs(video.currentTime - target) < 0.0001) return Promise.resolve();
    return new Promise((resolve) => {
        video.addEventListener("seeked", resolve, { once: true });
        video.currentTime = target;
    });
}

function makeCanvas(width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
}

function button(label, callback) {
    const element = document.createElement("button");
    element.textContent = label;
    element.onclick = callback;
    return element;
}

function nodeExecutionId(node) {
    const graph = node.graph;
    const rootGraph = graph?.rootGraph ?? app.rootGraph;
    if (!graph || graph === rootGraph || graph.isRootGraph) return String(node.id);

    function findPath(target, current) {
        for (const candidate of current.nodes ?? current._nodes ?? []) {
            if (!candidate.isSubgraphNode?.() || !candidate.subgraph) continue;
            if (candidate.subgraph === target) return String(candidate.id);
            const childPath = findPath(target, candidate.subgraph);
            if (childPath) return `${candidate.id}:${childPath}`;
        }
        return null;
    }

    const parentPath = findPath(graph, rootGraph);
    return parentPath ? `${parentPath}:${node.id}` : String(node.id);
}

function parseValue(widget, source) {
    let data = {};
    try { data = JSON.parse(widget.value || "{}"); } catch {}
    return {
        mode: data.mode ?? source.mode ?? "regenerate",
        selection_start: Number(data.selection_start ?? source.selection_start ?? 0),
        selection_end: Number(data.selection_end ?? source.selection_end ?? Math.min(source.frame_count, source.fps)),
        context_before: Number(data.context_before ?? source.context_before ?? 2),
        context_after: Number(data.context_after ?? source.context_after ?? 2),
        mask: data.mask ?? null,
    };
}

async function restoreMasks(state, widget) {
    if (state.loadedValue === widget.value) return;
    state.masks.clear();
    state.settings = parseValue(widget, state.source);
    state.loadedValue = widget.value;
    const data = state.settings.mask;
    if (!data?.frames?.length) return;
    const atlas = await loadImage(annotatedFileUrl(data.file));
    for (let index = 0; index < data.frames.length; index++) {
        const frame = Number(data.frames[index]);
        if (frame < 0 || frame >= state.source.frame_count) continue;
        const canvas = makeCanvas(state.source.width, state.source.height);
        const x = index % data.columns * data.width;
        const y = Math.floor(index / data.columns) * data.height;
        canvas.getContext("2d").drawImage(atlas, x, y, data.width, data.height, 0, 0, canvas.width, canvas.height);
        state.masks.set(frame, canvas);
    }
}

async function uploadMaskAtlas(state) {
    const entries = [...state.masks.entries()].sort((a, b) => a[0] - b[0]);
    if (!entries.length) return null;
    if (!state.masksDirty && state.settings.mask) return state.settings.mask;

    const width = state.source.width;
    const height = state.source.height;
    const maxSide = 16384;
    const maxColumns = Math.floor(maxSide / width);
    const maxRows = Math.floor(maxSide / height);
    const minColumns = Math.ceil(entries.length / maxRows);
    if (maxColumns < 1 || maxRows < 1 || minColumns > maxColumns) {
        throw new Error("Too many high-resolution mask frames for one atlas");
    }
    const columns = Math.max(minColumns, Math.min(maxColumns, Math.ceil(Math.sqrt(entries.length * height / width))));
    const rows = Math.ceil(entries.length / columns);
    const atlas = makeCanvas(columns * width, rows * height);
    const context = atlas.getContext("2d");
    entries.forEach(([, canvas], index) => context.drawImage(canvas, index % columns * width, Math.floor(index / columns) * height));

    const blob = await new Promise((resolve) => atlas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("Could not encode timeline masks");
    const body = new FormData();
    body.append("image", blob, `video-timeline-mask-${Date.now()}.png`);
    body.append("subfolder", "video-timeline");
    body.append("type", "input");
    const response = await api.fetchApi("/upload/image", { method: "POST", body });
    if (!response.ok) throw new Error(await response.text() || "Could not upload timeline masks");
    const uploaded = await response.json();
    return {
        file: `${[uploaded.subfolder, uploaded.name].filter(Boolean).join("/")} [${uploaded.type}]`,
        frames: entries.map(([frame]) => frame), columns, width, height,
    };
}

async function saveState(state, widget) {
    const mask = await uploadMaskAtlas(state);
    const value = JSON.stringify({ ...state.settings, mask });
    widget.value = value;
    widget.callback?.(value);
    state.settings.mask = mask;
    state.loadedValue = value;
    state.masksDirty = false;
    return value;
}

async function openTimeline(node) {
    const state = node.videoTimelineState;
    if (!state.source) {
        state.reopen = true;
        await app.queuePrompt(0, 1, [nodeExecutionId(node)]);
        return;
    }
    const widget = node.widgets?.find((item) => item.name === "timeline_data");
    await restoreMasks(state, widget);
    const source = state.source;
    const settings = state.settings;
    const videoUrl = resourceUrl(source.video);
    const video = await loadVideo(videoUrl);

    addStyles();
    const backdrop = document.createElement("div");
    backdrop.className = "video-timeline-backdrop";
    const editor = document.createElement("div");
    editor.className = "video-timeline-editor";
    backdrop.append(editor);
    document.body.append(backdrop);

    const title = document.createElement("div");
    title.textContent = "Video Timeline";
    title.style.fontWeight = "600";
    const hint = document.createElement("div");
    hint.className = "video-timeline-hint";
    hint.textContent = "Select a range to regenerate, or switch to Inpaint and paint only the pixels that should change. The audio lane is always preserved.";
    editor.append(title, hint);

    const modes = document.createElement("div");
    modes.className = "video-timeline-toolbar";
    const regenerate = button("Regenerate range", () => setMode("regenerate"));
    const inpaint = button("Inpaint mask", () => setMode("inpaint"));
    modes.append(regenerate, inpaint);
    editor.append(modes);

    const stage = document.createElement("div");
    stage.className = "video-timeline-stage";
    const frameCanvas = makeCanvas(source.width, source.height);
    const overlayCanvas = makeCanvas(source.width, source.height);
    stage.append(frameCanvas, overlayCanvas);
    editor.append(stage);
    const frameContext = frameCanvas.getContext("2d");
    const overlayContext = overlayCanvas.getContext("2d");
    const scratch = makeCanvas(source.width, source.height);
    const scratchContext = scratch.getContext("2d");

    const paintTools = document.createElement("div");
    paintTools.className = "video-timeline-toolbar";
    let paintTool = "brush";
    const brush = button("Brush", () => setPaintTool("brush"));
    const erase = button("Erase", () => setPaintTool("erase"));
    const size = document.createElement("input");
    size.type = "range";
    size.min = "1";
    size.max = String(Math.max(20, Math.round(Math.min(source.width, source.height) / 4)));
    size.value = String(Math.max(8, Math.round(Math.min(source.width, source.height) / 40)));
    const sizeLabel = document.createElement("span");
    sizeLabel.textContent = `Size ${size.value}`;
    size.oninput = () => sizeLabel.textContent = `Size ${size.value}`;
    const clearFrame = button("Clear frame", () => {
        state.masks.delete(frame);
        state.masksDirty = true;
        renderOverlay();
    });
    paintTools.append(brush, erase, sizeLabel, size, clearFrame);
    editor.append(paintTools);

    function setPaintTool(next) {
        paintTool = next;
        brush.classList.toggle("active", next === "brush");
        erase.classList.toggle("active", next === "erase");
    }

    function setMode(next) {
        settings.mode = next;
        regenerate.classList.toggle("active", next === "regenerate");
        inpaint.classList.toggle("active", next === "inpaint");
        paintTools.style.display = next === "inpaint" ? "flex" : "none";
        overlayCanvas.style.pointerEvents = next === "inpaint" ? "auto" : "none";
        renderOverlay();
    }
    setPaintTool("brush");

    let frame = settings.selection_start;
    let drawing = false;
    let lastPoint = null;
    let renderId = 0;

    function currentMask(create = false) {
        let canvas = state.masks.get(frame);
        if (!canvas && create) {
            canvas = makeCanvas(source.width, source.height);
            state.masks.set(frame, canvas);
        }
        return canvas;
    }

    function renderOverlay() {
        overlayContext.clearRect(0, 0, source.width, source.height);
        if (settings.mode !== "inpaint") return;
        const mask = currentMask();
        if (!mask) return;
        scratchContext.clearRect(0, 0, source.width, source.height);
        scratchContext.globalCompositeOperation = "source-over";
        scratchContext.drawImage(mask, 0, 0);
        scratchContext.globalCompositeOperation = "source-in";
        scratchContext.fillStyle = "#ff3030";
        scratchContext.fillRect(0, 0, source.width, source.height);
        overlayContext.globalAlpha = 0.72;
        overlayContext.drawImage(scratch, 0, 0);
        overlayContext.globalAlpha = 1;
        scratchContext.globalCompositeOperation = "source-over";
    }

    async function showFrame(nextFrame, seek = true) {
        frame = Math.max(0, Math.min(source.frame_count - 1, nextFrame));
        const id = ++renderId;
        if (seek) await seekVideo(video, (frame + 0.5) / source.fps);
        if (id !== renderId) return;
        frameContext.drawImage(video, 0, 0, source.width, source.height);
        renderOverlay();
        updateTimeline();
    }

    function point(event) {
        const rect = overlayCanvas.getBoundingClientRect();
        return { x: (event.clientX - rect.left) * source.width / rect.width, y: (event.clientY - rect.top) * source.height / rect.height };
    }

    function draw(event) {
        if (frame < settings.selection_start || frame >= settings.selection_end) return;
        const next = point(event);
        const context = currentMask(true).getContext("2d");
        context.save();
        context.globalCompositeOperation = paintTool === "erase" ? "destination-out" : "source-over";
        context.strokeStyle = "white";
        context.lineCap = "round";
        context.lineJoin = "round";
        context.lineWidth = Number(size.value);
        context.beginPath();
        context.moveTo(lastPoint?.x ?? next.x, lastPoint?.y ?? next.y);
        context.lineTo(next.x, next.y);
        context.stroke();
        context.restore();
        lastPoint = next;
        state.masksDirty = true;
        renderOverlay();
    }

    overlayCanvas.onpointerdown = (event) => {
        if (settings.mode !== "inpaint") return;
        video.pause();
        drawing = true;
        lastPoint = null;
        overlayCanvas.setPointerCapture(event.pointerId);
        draw(event);
    };
    overlayCanvas.onpointermove = (event) => drawing && draw(event);
    overlayCanvas.onpointerup = overlayCanvas.onpointercancel = () => { drawing = false; lastPoint = null; };

    const transport = document.createElement("div");
    transport.className = "video-timeline-toolbar";
    const play = button("▶", async () => {
        if (video.paused) {
            video.currentTime = frame / source.fps;
            await video.play();
            play.textContent = "❚❚";
            followPlayback();
        } else {
            video.pause();
            play.textContent = "▶";
        }
    });
    const timeLabel = document.createElement("span");
    timeLabel.className = "video-timeline-time";
    transport.append(button("← Frame", () => showFrame(frame - 1)), play, button("Frame →", () => showFrame(frame + 1)), timeLabel);
    editor.append(transport);

    function followPlayback() {
        if (video.paused || video.ended) { play.textContent = "▶"; return; }
        const next = Math.min(source.frame_count - 1, Math.floor(video.currentTime * source.fps));
        if (next !== frame) showFrame(next, false);
        requestAnimationFrame(followPlayback);
    }

    const lanes = document.createElement("div");
    lanes.className = "video-timeline-lanes";
    const videoLabel = document.createElement("div");
    videoLabel.className = "video-timeline-label";
    videoLabel.textContent = "VIDEO";
    const audioLabel = document.createElement("div");
    audioLabel.className = "video-timeline-label audio";
    audioLabel.textContent = source.has_audio ? "AUDIO" : "NO AUDIO";
    const videoLane = document.createElement("div");
    videoLane.className = "video-timeline-lane video-timeline-video";
    const audioLane = document.createElement("div");
    audioLane.className = "video-timeline-lane video-timeline-audio";
    const thumbnailCanvas = makeCanvas(1200, 68);
    const waveformCanvas = makeCanvas(1200, 44);
    videoLane.append(thumbnailCanvas);
    audioLane.append(waveformCanvas);
    const contextRange = document.createElement("div");
    contextRange.className = "video-timeline-context";
    const selection = document.createElement("div");
    selection.className = "video-timeline-selection";
    const playhead = document.createElement("div");
    playhead.className = "video-timeline-playhead";
    lanes.append(videoLabel, audioLabel, videoLane, audioLane, contextRange, selection, playhead);
    editor.append(lanes);

    const laneStart = 72;
    function frameAt(event) {
        const rect = lanes.getBoundingClientRect();
        const x = Math.max(0, Math.min(rect.width - laneStart, event.clientX - rect.left - laneStart));
        return Math.min(source.frame_count, Math.round(x / (rect.width - laneStart) * source.frame_count));
    }

    let drag = null;
    selection.onpointerdown = (event) => {
        const rect = selection.getBoundingClientRect();
        const edge = 12;
        drag = event.clientX - rect.left < edge ? "start" : rect.right - event.clientX < edge ? "end" : "move";
        selection.setPointerCapture(event.pointerId);
        selection.dragFrame = frameAt(event);
        event.stopPropagation();
    };
    selection.onpointermove = (event) => {
        if (!drag) return;
        const next = frameAt(event);
        if (drag === "start") settings.selection_start = Math.min(settings.selection_end - 1, Math.max(0, next));
        if (drag === "end") settings.selection_end = Math.max(settings.selection_start + 1, Math.min(source.frame_count, next));
        if (drag === "move") {
            const delta = next - selection.dragFrame;
            const length = settings.selection_end - settings.selection_start;
            settings.selection_start = Math.max(0, Math.min(source.frame_count - length, settings.selection_start + delta));
            settings.selection_end = settings.selection_start + length;
            selection.dragFrame = next;
        }
        updateTimeline();
    };
    selection.onpointerup = selection.onpointercancel = () => drag = null;
    lanes.onpointerdown = (event) => {
        const next = Math.min(source.frame_count - 1, frameAt(event));
        showFrame(next);
    };

    const settingsRow = document.createElement("div");
    settingsRow.className = "video-timeline-toolbar";
    const before = document.createElement("input");
    before.className = "video-timeline-context-input";
    before.type = "number"; before.min = "0"; before.step = "0.1"; before.value = String(settings.context_before);
    const after = document.createElement("input");
    after.className = "video-timeline-context-input";
    after.type = "number"; after.min = "0"; after.step = "0.1"; after.value = String(settings.context_after);
    before.oninput = () => { settings.context_before = Math.max(0, Number(before.value)); updateTimeline(); };
    after.oninput = () => { settings.context_after = Math.max(0, Number(after.value)); updateTimeline(); };
    settingsRow.append("Context before", before, "seconds", "Context after", after, "seconds");
    editor.append(settingsRow);

    function updateTimeline() {
        const width = source.frame_count;
        const left = settings.selection_start / width * 100;
        const right = settings.selection_end / width * 100;
        selection.style.left = `calc(72px + (100% - 72px) * ${left / 100})`;
        selection.style.width = `calc((100% - 72px) * ${(right - left) / 100})`;
        const contextStart = Math.max(0, settings.selection_start - settings.context_before * source.fps);
        const contextEnd = Math.min(width, settings.selection_end + settings.context_after * source.fps);
        contextRange.style.left = `calc(72px + (100% - 72px) * ${contextStart / width})`;
        contextRange.style.width = `calc((100% - 72px) * ${(contextEnd - contextStart) / width})`;
        playhead.style.left = `calc(72px + (100% - 72px) * ${(frame + 0.5) / width})`;
        timeLabel.textContent = `Frame ${frame + 1}/${width}  •  ${(frame / source.fps).toFixed(2)}s  •  selection ${(settings.selection_start / source.fps).toFixed(2)}–${(settings.selection_end / source.fps).toFixed(2)}s`;
    }

    function drawWaveform() {
        const context = waveformCanvas.getContext("2d");
        context.fillStyle = "#171717";
        context.fillRect(0, 0, waveformCanvas.width, waveformCanvas.height);
        if (!source.waveform.length) return;
        context.strokeStyle = "#65d58a";
        context.beginPath();
        source.waveform.forEach((value, index) => {
            const x = index / (source.waveform.length - 1 || 1) * waveformCanvas.width;
            const height = value * waveformCanvas.height * 0.45;
            context.moveTo(x, waveformCanvas.height / 2 - height);
            context.lineTo(x, waveformCanvas.height / 2 + height);
        });
        context.stroke();
    }

    async function drawThumbnails() {
        const context = thumbnailCanvas.getContext("2d");
        const thumbs = Math.max(6, Math.min(18, Math.round(thumbnailCanvas.width / 100)));
        const thumbVideo = await loadVideo(videoUrl);
        thumbVideo.muted = true;
        for (let index = 0; index < thumbs; index++) {
            await seekVideo(thumbVideo, (index + 0.5) / thumbs * thumbVideo.duration);
            const x = Math.round(index / thumbs * thumbnailCanvas.width);
            const nextX = Math.round((index + 1) / thumbs * thumbnailCanvas.width);
            context.drawImage(thumbVideo, x, 0, nextX - x, thumbnailCanvas.height);
        }
    }

    const actions = document.createElement("div");
    actions.className = "video-timeline-toolbar";
    const spacer = document.createElement("span");
    spacer.className = "video-timeline-spacer";
    const close = () => { video.pause(); backdrop.remove(); };
    actions.append(
        spacer,
        button("Save", async () => { await saveState(state, widget); close(); }),
        button("Save & queue", async () => { await saveState(state, widget); close(); await app.queuePrompt(0, 1); }),
        button("Close", close),
    );
    editor.append(actions);
    backdrop.onclick = (event) => event.target === backdrop && close();

    setMode(settings.mode);
    drawWaveform();
    drawThumbnails();
    await showFrame(frame);
}

app.registerExtension({
    name: "Comfy.VideoTimeline",
    nodeCreated(node) {
        if (node.constructor.comfyClass !== "VideoTimeline") return;
        const widget = node.widgets?.find((item) => item.name === "timeline_data");
        widget.hidden = true;
        widget.options.hidden = true;
        node.videoTimelineState = {
            source: null,
            settings: null,
            masks: new Map(),
            masksDirty: false,
            loadedValue: null,
            reopen: false,
        };
        widget.serializeValue = () => node.videoTimelineState.settings
            ? saveState(node.videoTimelineState, widget)
            : widget.value;

        const open = node.addWidget("button", "Open video timeline", null, () => openTimeline(node));
        open.serializeValue = () => undefined;
        const [width, height] = node.size;
        node.setSize([Math.max(width, 320), Math.max(height, 210)]);

        const onExecuted = node.onExecuted;
        node.onExecuted = function(output) {
            onExecuted?.call(this, output);
            const source = output.video_timeline?.[0];
            if (!source) return;
            node.videoTimelineState.source = source;
            node.videoTimelineState.loadedValue = null;
            open.name = "Open video timeline";
            app.canvas.setDirty(true);
            if (node.videoTimelineState.reopen) {
                node.videoTimelineState.reopen = false;
                openTimeline(node);
            }
        };
    },
});
