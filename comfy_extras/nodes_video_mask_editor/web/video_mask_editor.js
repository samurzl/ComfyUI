import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const STYLE_ID = "comfy-video-mask-editor-style";

function addStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
        .video-mask-editor-backdrop { position: fixed; inset: 0; z-index: 10000; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.78); }
        .video-mask-editor { width: min(92vw, 1200px); max-height: 94vh; overflow: auto; padding: 14px; border: 1px solid #555; border-radius: 10px; background: #202020; color: #eee; box-shadow: 0 20px 70px #000; }
        .video-mask-editor-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 8px 0; }
        .video-mask-editor button, .video-mask-editor input { color: inherit; background: #333; border: 1px solid #666; border-radius: 5px; padding: 6px 10px; }
        .video-mask-editor button.active { background: #9b3030; border-color: #ef7777; }
        .video-mask-editor-stage { position: relative; width: fit-content; max-width: 100%; margin: 10px auto; line-height: 0; background: #000; }
        .video-mask-editor-stage canvas { display: block; max-width: 86vw; max-height: 66vh; width: auto; height: auto; }
        .video-mask-editor-stage canvas + canvas { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; cursor: crosshair; }
        .video-mask-editor-frame { min-width: 115px; text-align: center; }
        .video-mask-editor-range { flex: 1; min-width: 180px; }
        .video-mask-editor-spacer { flex: 1; }
        .video-mask-editor-hint { color: #bbb; font-size: 12px; }
    `;
    document.head.appendChild(style);
}

function resourceUrl(record) {
    if (!record) return null;
    return api.apiURL(`/view?${new URLSearchParams(record)}`);
}

function annotatedFileUrl(file) {
    const match = /^(.*?)(?: \[(input|output|temp)\])?$/.exec(file);
    const path = match?.[1] ?? file;
    const type = match?.[2] ?? "input";
    const slash = path.lastIndexOf("/");
    const filename = slash < 0 ? path : path.slice(slash + 1);
    const subfolder = slash < 0 ? "" : path.slice(0, slash);
    return api.apiURL(`/view?${new URLSearchParams({ filename, subfolder, type })}`);
}

function loadImage(url) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("Could not load saved video masks"));
        image.src = url;
    });
}

function loadVideo(url) {
    return new Promise((resolve, reject) => {
        const video = document.createElement("video");
        video.muted = true;
        video.preload = "auto";
        video.playsInline = true;
        video.onloadedmetadata = () => resolve(video);
        video.onerror = () => reject(new Error("Could not load video preview"));
        video.src = url;
    });
}

function seekVideo(video, time) {
    if (!video) return Promise.resolve();
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

async function restoreMasks(state, maskWidget) {
    const value = maskWidget.value || "";
    if (state.loadedValue === value) return;
    state.masks.clear();
    state.loadedValue = value;
    if (!value) return;

    const data = JSON.parse(value);
    const atlas = await loadImage(annotatedFileUrl(data.file));
    for (let index = 0; index < data.frames.length; index++) {
        const frame = Number(data.frames[index]);
        if (frame < 0 || frame >= state.source.frame_count) continue;
        const canvas = makeCanvas(state.source.width, state.source.height);
        const x = index % data.columns * data.width;
        const y = Math.floor(index / data.columns) * data.height;
        canvas.getContext("2d").drawImage(
            atlas,
            x, y, data.width, data.height,
            0, 0, canvas.width, canvas.height,
        );
        state.masks.set(frame, canvas);
    }
}

async function uploadMasks(state, maskWidget) {
    if (!state.dirty) return maskWidget.value || "";
    const entries = [...state.masks.entries()].sort((a, b) => a[0] - b[0]);
    if (!entries.length) {
        maskWidget.value = "";
        state.loadedValue = "";
        state.dirty = false;
        return "";
    }

    const width = state.source.width;
    const height = state.source.height;
    const maxSide = 16384;
    const maxColumns = Math.floor(maxSide / width);
    const maxRows = Math.floor(maxSide / height);
    const minColumns = Math.ceil(entries.length / maxRows);
    if (maxColumns < 1 || maxRows < 1 || minColumns > maxColumns) {
        throw new Error("Too many high-resolution keyframes for one mask atlas");
    }
    const idealColumns = Math.ceil(Math.sqrt(entries.length * height / width));
    const columns = Math.max(minColumns, Math.min(maxColumns, idealColumns));
    const rows = Math.ceil(entries.length / columns);
    const atlas = makeCanvas(columns * width, rows * height);
    const context = atlas.getContext("2d");
    entries.forEach(([, canvas], index) => {
        context.drawImage(canvas, index % columns * width, Math.floor(index / columns) * height);
    });

    const blob = await new Promise((resolve) => atlas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("Could not encode video masks");
    const body = new FormData();
    body.append("image", blob, `video-mask-${Date.now()}.png`);
    body.append("subfolder", "video-mask-editor");
    body.append("type", "input");
    const response = await api.fetchApi("/upload/image", { method: "POST", body });
    if (!response.ok) throw new Error(await response.text() || "Could not upload video masks");
    const uploaded = await response.json();
    const path = [uploaded.subfolder, uploaded.name].filter(Boolean).join("/");
    const value = JSON.stringify({
        file: `${path} [${uploaded.type}]`,
        frames: entries.map(([frame]) => frame),
        columns,
        width,
        height,
    });
    maskWidget.value = value;
    state.loadedValue = value;
    state.dirty = false;
    return value;
}

function button(label, callback) {
    const element = document.createElement("button");
    element.textContent = label;
    element.onclick = callback;
    return element;
}

async function openEditor(node) {
    const state = node.videoMaskEditorState;
    const source = state.source;
    if (!source) {
        alert("Queue this node once to load its video.");
        return;
    }

    const maskWidget = node.widgets?.find((widget) => widget.name === "mask_data");
    const trackingWidget = node.widgets?.find((widget) => widget.name === "tracking");
    await restoreMasks(state, maskWidget);
    const video = await loadVideo(resourceUrl(source.video));
    const trackedVideo = source.mask ? await loadVideo(resourceUrl(source.mask)) : null;

    addStyles();
    const backdrop = document.createElement("div");
    backdrop.className = "video-mask-editor-backdrop";
    const editor = document.createElement("div");
    editor.className = "video-mask-editor";
    backdrop.append(editor);
    document.body.append(backdrop);

    const title = document.createElement("div");
    title.textContent = "Video Mask Editor";
    title.style.fontWeight = "600";
    const hint = document.createElement("div");
    hint.className = "video-mask-editor-hint";
    hint.textContent = "Red is hand-painted; green is the latest tracked result. Painted frames are correction keyframes.";
    editor.append(title, hint);

    const tools = document.createElement("div");
    tools.className = "video-mask-editor-toolbar";
    let tool = "brush";
    const brush = button("Brush", () => setTool("brush"));
    const eraser = button("Erase", () => setTool("erase"));
    brush.classList.add("active");
    const size = document.createElement("input");
    size.type = "range";
    size.min = "1";
    size.max = String(Math.max(20, Math.round(Math.min(source.width, source.height) / 4)));
    size.value = String(Math.max(8, Math.round(Math.min(source.width, source.height) / 40)));
    const sizeLabel = document.createElement("span");
    sizeLabel.textContent = `Size ${size.value}`;
    size.oninput = () => sizeLabel.textContent = `Size ${size.value}`;
    tools.append(brush, eraser, sizeLabel, size);
    editor.append(tools);

    function setTool(next) {
        tool = next;
        brush.classList.toggle("active", tool === "brush");
        eraser.classList.toggle("active", tool === "erase");
    }

    const stage = document.createElement("div");
    stage.className = "video-mask-editor-stage";
    const frameCanvas = makeCanvas(source.width, source.height);
    const overlayCanvas = makeCanvas(source.width, source.height);
    stage.append(frameCanvas, overlayCanvas);
    editor.append(stage);
    const frameContext = frameCanvas.getContext("2d");
    const overlayContext = overlayCanvas.getContext("2d");
    const scratch = makeCanvas(source.width, source.height);
    const scratchContext = scratch.getContext("2d");

    let frame = 0;
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
        if (trackedVideo) {
            scratchContext.globalCompositeOperation = "source-over";
            scratchContext.clearRect(0, 0, source.width, source.height);
            scratchContext.fillStyle = "#00ff70";
            scratchContext.fillRect(0, 0, source.width, source.height);
            scratchContext.globalCompositeOperation = "multiply";
            scratchContext.drawImage(trackedVideo, 0, 0, source.width, source.height);
            overlayContext.save();
            overlayContext.globalCompositeOperation = "screen";
            overlayContext.globalAlpha = 0.45;
            overlayContext.drawImage(scratch, 0, 0);
            overlayContext.restore();
        }
        const manual = currentMask();
        if (manual) {
            scratchContext.globalCompositeOperation = "source-over";
            scratchContext.clearRect(0, 0, source.width, source.height);
            scratchContext.drawImage(manual, 0, 0);
            scratchContext.globalCompositeOperation = "source-in";
            scratchContext.fillStyle = "#ff3030";
            scratchContext.fillRect(0, 0, source.width, source.height);
            overlayContext.drawImage(scratch, 0, 0);
        }
        scratchContext.globalCompositeOperation = "source-over";
    }

    async function showFrame(nextFrame) {
        frame = Math.max(0, Math.min(source.frame_count - 1, nextFrame));
        range.value = String(frame);
        const id = ++renderId;
        const time = (frame + 0.5) / source.fps;
        await Promise.all([seekVideo(video, time), seekVideo(trackedVideo, time)]);
        if (id !== renderId) return;
        frameContext.drawImage(video, 0, 0, source.width, source.height);
        renderOverlay();
        frameLabel.textContent = `Frame ${frame + 1} / ${source.frame_count}${state.masks.has(frame) ? " • keyframe" : ""}`;
    }

    function point(event) {
        const rect = overlayCanvas.getBoundingClientRect();
        return {
            x: (event.clientX - rect.left) * source.width / rect.width,
            y: (event.clientY - rect.top) * source.height / rect.height,
        };
    }

    function draw(event) {
        const next = point(event);
        const context = currentMask(true).getContext("2d");
        context.save();
        context.globalCompositeOperation = tool === "erase" ? "destination-out" : "source-over";
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
        state.dirty = true;
        renderOverlay();
        frameLabel.textContent = `Frame ${frame + 1} / ${source.frame_count} • keyframe`;
    }

    overlayCanvas.onpointerdown = (event) => {
        drawing = true;
        lastPoint = null;
        overlayCanvas.setPointerCapture(event.pointerId);
        draw(event);
    };
    overlayCanvas.onpointermove = (event) => drawing && draw(event);
    overlayCanvas.onpointerup = overlayCanvas.onpointercancel = () => {
        drawing = false;
        lastPoint = null;
    };

    const navigation = document.createElement("div");
    navigation.className = "video-mask-editor-toolbar";
    const previous = button("←", () => showFrame(frame - 1));
    const next = button("→", () => showFrame(frame + 1));
    const range = document.createElement("input");
    range.className = "video-mask-editor-range";
    range.type = "range";
    range.min = "0";
    range.max = String(source.frame_count - 1);
    range.value = "0";
    range.oninput = () => showFrame(Number(range.value));
    const frameLabel = document.createElement("span");
    frameLabel.className = "video-mask-editor-frame";
    const clear = button("Clear frame", () => {
        state.masks.delete(frame);
        state.dirty = true;
        renderOverlay();
        frameLabel.textContent = `Frame ${frame + 1} / ${source.frame_count}`;
    });
    navigation.append(previous, range, next, frameLabel, clear);
    editor.append(navigation);

    const actions = document.createElement("div");
    actions.className = "video-mask-editor-toolbar";
    const spacer = document.createElement("span");
    spacer.className = "video-mask-editor-spacer";
    const close = () => backdrop.remove();
    const save = button("Save masks", async () => {
        await uploadMasks(state, maskWidget);
        close();
    });
    const runTracking = async (direction) => {
        await uploadMasks(state, maskWidget);
        trackingWidget.value = direction;
        trackingWidget.callback?.(direction);
        state.reopen = true;
        close();
        await app.queuePrompt(0, 1, [node.id]);
    };
    actions.append(
        button("Track backward", () => runTracking("backward")),
        button("Track forward", () => runTracking("forward")),
        button("Track both", () => runTracking("both")),
        spacer,
        save,
        button("Close", close),
    );
    editor.append(actions);

    backdrop.onclick = (event) => event.target === backdrop && close();
    await showFrame(0);
}

app.registerExtension({
    name: "Comfy.VideoMaskEditor",
    nodeCreated(node) {
        if (node.constructor.comfyClass !== "VideoMaskEditor") return;

        const maskWidget = node.widgets?.find((widget) => widget.name === "mask_data");
        maskWidget.hidden = true;
        maskWidget.options.hidden = true;
        node.videoMaskEditorState = {
            source: null,
            masks: new Map(),
            loadedValue: null,
            dirty: false,
            reopen: false,
        };
        maskWidget.serializeValue = () => uploadMasks(node.videoMaskEditorState, maskWidget);

        const open = node.addWidget("button", "Queue once to load video", null, () => openEditor(node));
        open.serializeValue = () => undefined;
        const [width, height] = node.size;
        node.setSize([Math.max(width, 300), Math.max(height, 170)]);

        const onExecuted = node.onExecuted;
        node.onExecuted = function(output) {
            onExecuted?.call(this, output);
            const source = output.video_mask_editor?.[0];
            if (!source) return;
            node.videoMaskEditorState.source = source;
            open.name = "Open mask editor";
            app.canvas.setDirty(true);
            if (node.videoMaskEditorState.reopen) {
                node.videoMaskEditorState.reopen = false;
                openEditor(node);
            }
        };
    },
});
