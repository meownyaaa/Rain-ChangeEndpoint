import { intercept } from "@api/flux";
import { after, before, instead } from "@api/patcher";
import { findByStoreName } from "@metro";
import { ReactNative } from "@metro/common";

import { state } from "./state";

// the ChangeEndpointVoice tweak answers FileReaderModule.readAsDataURL calls tagged changeEndpoint
async function native<T = unknown>(method: string, args: unknown[] = []): Promise<T> {
    const reader = ReactNative.NativeModules.FileReaderModule;
    const res = await reader.readAsDataURL({ changeEndpoint: { method, args } });
    if (res && typeof res === "object" && "error" in res) throw new Error(String(res.error));
    if (!res || typeof res !== "object" || !("result" in res)) throw new Error("ChangeEndpointVoice tweak isn't installed");
    return res.result as T;
}

interface Connection {
    emit(event: string, ...args: unknown[]): unknown;
    setConnectionState(state: string): void;
    setSDP(sdp: string): void;
    setSelfMute(muted: boolean): void;
    setSelfDeaf(deafened: boolean): void;
    destroy(): void;
    // native engine callback, it looks up the user's ssrcs and emits "video" so the ui gets a stream id
    handleVideo?(userId: string, ssrc: number, streamId: string | null, params: unknown): void;
}

interface VideoUser {
    ssrc: number;
    userId: string;
    streamId?: string;
}

interface Session {
    id: string;
    conn: Connection;
    // "default" is the voice call, "stream" is a go live being watched
    context: string;
    serverSsrc: number;
    ws?: WebSocket;
    ssrc: number;
    localSdp: string;
    fragment?: string;
    users: Map<number, string>;
    // video sections are bound to senders by mid
    video: Map<string, VideoUser>;
    op12?: Record<string, unknown>;
    codecs: Record<string, unknown>[];
    queue: Promise<unknown>;
    muted: boolean;
    // the local offer the last answer was applied to, a new answer needs a new offer
    answeredSdp?: string;
    onEngineState(value: string): void;
}

// one session per media connection, a stream being watched runs next to the voice call
const sessions = new Map<string, Session>();
const sessionBySocket = new Map<WebSocket, Session>();
const sockets = new WeakSet<WebSocket>();
let nextSessionId = 1;

const sends = (s: Session) => s.context === "default";

// mobile never sends op 12/op 5 for our transport, so the server wouldn't forward our audio
const sendVoice = (s: Session, op: number, d: Record<string, unknown>) => {
    if (s.ws?.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify({ op, d }));
};
const sendSpeaking = (s: Session) => sendVoice(s, 5, { speaking: s.muted ? 0 : 1, delay: 0, ssrc: s.ssrc });

const debugLog: string[] = ((globalThis as { __ceVoiceLog?: string[] }).__ceVoiceLog = []);
(globalThis as { __ceVoiceStats?: unknown }).__ceVoiceStats = () => Promise.all([...sessions.keys()].map(id => native("voice.stats", [id]).then(stats => ({ id, stats }))));
const debug = (line: string) => {
    if (debugLog.length > 200) debugLog.shift();
    debugLog.push(`${new Date().toISOString().slice(11, 23)} ${line}`);
    // also to the console, so a debugger keeps it when the app crashes
    console.log(`[ChangeEndpoint] voice ${line}`);
};

const run = <T>(s: Session, task: () => Promise<T>) => {
    const next = s.queue.then(task, task);
    s.queue = next.catch(e => {
        debug(`error ${String(e?.message ?? e).slice(0, 300)}`);
        console.warn("[ChangeEndpoint] voice:", e);
    });
    return next;
};

const sdpAttrs = (section: string, name: string) =>
    section
        .split(/\r?\n/)
        .filter(l => l.startsWith(`a=${name}:`))
        .map(l => l.slice(name.length + 3));

// op 4 fragments start with m= directly
const sections = (sdp: string) => `\n${sdp}`.split(/\r?\nm=/).slice(1).map(s => `m=${s}`);

const VIDEO_PRIORITY: Record<string, number> = { H264: 1000, VP8: 2000, VP9: 3000 };
const isVideo = (section: string) => section.startsWith("m=video");

// the server only knows the payload types op 1 tells it, so they come from the engine's own video section
function videoCodecs(sdp: string) {
    const section = sections(sdp).find(isVideo);
    if (!section) return [];
    const rtpmaps = sdpAttrs(section, "rtpmap").map(r => r.split(" ")) as [string, string][];
    const fmtps = sdpAttrs(section, "fmtp");
    const fmtp = (pt: string) => fmtps.find(f => f.startsWith(`${pt} `)) ?? "";
    const rtxOf = (pt: string) => fmtps.find(f => f.endsWith(` apt=${pt}`))?.split(" ")[0];
    return Object.keys(VIDEO_PRIORITY).flatMap(name => {
        const pts = rtpmaps.filter(([, codec]) => codec === `${name}/90000`).map(([pt]) => pt);
        // desktop senders use constrained baseline
        const pt = name === "H264" ? (pts.find(p => /profile-level-id=42e01f/.test(fmtp(p)) && /packetization-mode=1/.test(fmtp(p))) ?? pts[0]) : pts[0];
        if (!pt) return [];
        const rtx = rtxOf(pt);
        return [{ name, type: "video", priority: VIDEO_PRIORITY[name], payload_type: Number(pt), rtx_payload_type: rtx ? Number(rtx) : null }];
    });
}

function trimOffer(sdp: string) {
    const all = sections(sdp);
    const [first] = all;
    const head = sdp.split(/\r?\nm=/)[0];
    const pick = (name: string) => sdpAttrs(first, name)[0] ?? sdpAttrs(head, name)[0];
    const opus = sdpAttrs(first, "rtpmap").find(r => r.includes("opus/48000"));
    const video = videoCodecs(sdp);
    const lines = [
        "a=extmap-allow-mixed",
        `a=ice-ufrag:${pick("ice-ufrag")}`,
        `a=ice-pwd:${pick("ice-pwd")}`,
        "a=ice-options:trickle",
        `a=fingerprint:${pick("fingerprint")}`,
        ...[...new Set(all.flatMap(m => sdpAttrs(m, "extmap")))].map(e => `a=extmap:${e}`),
        `a=rtpmap:${opus}`,
        ...video.flatMap(c => [`a=rtpmap:${c.payload_type} ${c.name}/90000`, ...(c.rtx_payload_type ? [`a=rtpmap:${c.rtx_payload_type} rtx/90000`] : [])]),
    ];
    return { sdp: lines.join("\n"), opusPt: Number(opus?.split(" ")[0] ?? 111), video };
}

function buildAnswer(s: Session) {
    const { fragment } = s;
    if (!fragment) return null;
    const [server] = sections(fragment);
    const port = server.match(/^m=\w+ (\d+)/)?.[1] ?? "6500";
    const cline = fragment.split(/\r?\n/).find(l => l.startsWith("c=")) ?? "c=IN IP4 0.0.0.0";
    const rtcp = sdpAttrs(server, "rtcp")[0] ?? port;
    const ufrag = sdpAttrs(server, "ice-ufrag")[0];
    const pwd = sdpAttrs(server, "ice-pwd")[0];
    const fingerprint = sdpAttrs(server, "fingerprint")[0];
    const candidate = sdpAttrs(server, "candidate")[0];
    const local = sections(s.localSdp);
    const mids = local.map(m => sdpAttrs(m, "mid")[0]);
    const users = [...s.users];
    const { opusPt: pt, video } = trimOffer(s.localSdp);
    const h264 = video.find(c => c.name === "H264");
    let audioIndex = 0;

    const media = local.map((section, i) => {
        if (isVideo(section)) {
            const bound = s.video.get(mids[i]);
            const vpt = h264?.payload_type ?? 0;
            const rtx = h264?.rtx_payload_type;
            const label = bound && `${bound.userId}-${bound.ssrc}`;
            return [
                `m=video ${port} UDP/TLS/RTP/SAVPF ${vpt}${rtx ? ` ${rtx}` : ""}`,
                cline,
                `a=rtpmap:${vpt} H264/90000`,
                ...(rtx ? [`a=rtpmap:${rtx} rtx/90000`] : []),
                `a=fmtp:${vpt} level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f`,
                ...(rtx ? [`a=fmtp:${rtx} apt=${vpt}`] : []),
                `a=rtcp:${rtcp}`,
                ...["ccm fir", "nack", "nack pli", "goog-remb", "transport-cc"].map(fb => `a=rtcp-fb:${vpt} ${fb}`),
                "a=setup:passive",
                `a=mid:${mids[i]}`,
                ...(label ? [`a=msid:${label} v${label}`] : []),
                bound ? "a=sendonly" : "a=inactive",
                `a=ice-ufrag:${ufrag}`,
                `a=ice-pwd:${pwd}`,
                `a=fingerprint:${fingerprint}`,
                `a=candidate:${candidate}`,
                ...(label ? [`a=ssrc:${bound.ssrc} cname:${label}`] : []),
                "a=rtcp-mux",
            ].join("\r\n");
        }
        const index = audioIndex++;
        const user = index === 0 ? undefined : users[index - 1];
        return [
            `m=audio ${port} UDP/TLS/RTP/SAVPF ${pt}`,
            cline,
            `a=rtpmap:${pt} opus/48000/2`,
            `a=fmtp:${pt} minptime=10;useinbandfec=1;usedtx=1`,
            `a=rtcp:${rtcp}`,
            `a=rtcp-fb:${pt} transport-cc`,
            "a=setup:passive",
            `a=mid:${mids[i]}`,
            ...(user ? [`a=msid:${user[1]}-${user[0]} a${user[1]}-${user[0]}`] : []),
            "a=maxptime:60",
            index === 0 ? "a=recvonly" : user ? "a=sendonly" : "a=inactive",
            `a=ice-ufrag:${ufrag}`,
            `a=ice-pwd:${pwd}`,
            `a=fingerprint:${fingerprint}`,
            `a=candidate:${candidate}`,
            ...(user ? [`a=ssrc:${user[0]} cname:${user[1]}-${user[0]}`] : []),
            "a=rtcp-mux",
        ].join("\r\n");
    });

    return ["v=0", "o=- 1420070400000 0 IN IP4 127.0.0.1", "s=-", "t=0 0", "a=msid-semantic: WMS *", `a=group:BUNDLE ${mids.join(" ")}`, ...media, ""].join("\r\n");
}

const applyAnswer = (s: Session) => run(s, () => applyAnswerNow(s));

async function applyAnswerNow(s: Session): Promise<void> {
    const answer = buildAnswer(s);
    if (!answer) return debug("answer skipped, no fragment");
    if (s.answeredSdp === s.localSdp) {
        s.localSdp = await native<string>("voice.renegotiate", [s.id]);
        return applyAnswerNow(s);
    }
    debug(`${s.id} answer apply users=${s.users.size} video=${s.video.size}`);
    await native("voice.answer", [s.id, answer]);
    s.answeredSdp = s.localSdp;
    debug("answer applied");
    await attachVideo(s);
}

// once the answer is in, the receiver track is handed to Discord's renderer under our stream id
async function attachVideo(s: Session) {
    for (const [mid, user] of s.video) {
        if (user.streamId) continue;
        const streamId = `${s.id}-${user.ssrc}`;
        const ok = await native<boolean>("video.attach", [s.id, mid, streamId]);
        debug(`${s.id} video attach mid=${mid} ssrc=${user.ssrc} ok=${ok}`);
        if (!ok) continue;
        user.streamId = streamId;
        try {
            s.conn.handleVideo?.(user.userId, user.ssrc, streamId, null);
        } catch (e) {
            debug(`${s.id} handleVideo failed ${String((e as Error)?.message ?? e)}`);
        }
    }
}

function videoMids(s: Session) {
    return sections(s.localSdp).filter(isVideo).map(m => sdpAttrs(m, "mid")[0]);
}

function stopVideo(s: Session, userId: string) {
    for (const [mid, user] of s.video) {
        if (user.userId !== userId) continue;
        s.video.delete(mid);
        debug(`${s.id} video stop ${userId}`);
        if (user.streamId) {
            try {
                s.conn.handleVideo?.(userId, 0, null, null);
            } catch {}
        }
    }
}

async function bindVideo(s: Session, ssrc: number, userId: string) {
    if ([...s.video.values()].some(v => v.ssrc === ssrc)) return;
    stopVideo(s, userId);
    let mid = videoMids(s).find(m => !s.video.has(m));
    if (!mid) {
        s.localSdp = await native<string>("voice.addVideoReceiver", [s.id]);
        mid = videoMids(s).find(m => !s.video.has(m));
    }
    if (!mid) return debug(`${s.id} no video section for ${ssrc}`);
    s.video.set(mid, { ssrc, userId });
    debug(`${s.id} video bind mid=${mid} ssrc=${ssrc} user=${userId}`);
}

// the tweak queues engine events, they're polled while a call is up
let polling: ReturnType<typeof setInterval> | null = null;
function pollEvents() {
    if (!sessions.size) {
        if (polling) clearInterval(polling);
        polling = null;
        return;
    }
    polling ??= setInterval(async () => {
        let events: [string, string, string][];
        try {
            events = await native<[string, string, string][]>("events");
        } catch {
            return;
        }
        for (const [id, type, value] of events) {
            debug(`${id} engine ${type}=${value}`);
            const s = sessions.get(id);
            if (!s || type !== "connection") continue;
            s.onEngineState(value);
            if (value === "CONNECTED" && sends(s)) republish(s);
        }
    }, 300);
}

function takeOver(conn: Connection, context: string, serverSsrc: number) {
    let ours = false;
    const asOurs = (fn: () => void) => {
        ours = true;
        try {
            fn();
        } finally {
            ours = false;
        }
    };

    const { setConnectionState, emit, setSelfMute, setSelfDeaf, destroy } = conn;
    const s: Session = {
        id: `ce${nextSessionId++}`,
        conn,
        context,
        serverSsrc,
        ssrc: 0,
        localSdp: "",
        users: new Map(),
        video: new Map(),
        codecs: [],
        queue: Promise.resolve(),
        muted: false,
        onEngineState(value) {
            if (value === "CONNECTED") asOurs(() => setConnectionState.call(conn, "CONNECTED"));
            else if (value === "FAILED" || value === "CLOSED") asOurs(() => setConnectionState.call(conn, "DISCONNECTED"));
        },
    };
    sessions.set(s.id, s);
    debug(`${s.id} ${context} connect, server ssrc ${serverSsrc}`);

    conn.setConnectionState = function (value) {
        if (ours) setConnectionState.call(this, value);
    };
    conn.emit = function (event, ...args) {
        if (!ours && (event === "error" || event === "connectionstatechange")) return;
        return emit.call(this, event, ...args);
    };
    conn.setSDP = () => {};
    conn.setSelfMute = function (muted) {
        if (sends(s)) {
            native("voice.setMuted", [s.id, !!muted]).catch(() => {});
            if (s.muted !== !!muted) {
                s.muted = !!muted;
                sendSpeaking(s);
            }
        }
        return setSelfMute.call(this, muted);
    };
    conn.setSelfDeaf = function (deafened) {
        native("voice.setDeafened", [s.id, !!deafened]).catch(() => {});
        return setSelfDeaf.call(this, deafened);
    };
    conn.destroy = function () {
        sessions.delete(s.id);
        if (s.ws) sessionBySocket.delete(s.ws);
        pollEvents();
        native("voice.close", [s.id]).catch(() => {});
        return destroy.call(this);
    };

    asOurs(() => setConnectionState.call(conn, "CONNECTING"));
    pollEvents();

    // every session offers a receive-only video section, it's where op 1 gets the real video payload types
    native<string>("voice.offer", [s.id, sends(s), true]).then(
        sdp => {
            s.ssrc = Number(sdp.match(/a=ssrc:(\d+)/)?.[1] ?? 0);
            s.localSdp = sdp;
            // Discord applies the join mute before we take over
            s.muted = !!(conn as { selfMute?: boolean }).selfMute;
            if (sends(s) && s.muted) native("voice.setMuted", [s.id, true]).catch(() => {});
            if ((conn as { selfDeaf?: boolean }).selfDeaf) native("voice.setDeafened", [s.id, true]).catch(() => {});
            const { sdp: trimmed, opusPt, video } = trimOffer(sdp);
            debug(`${s.id} video codecs ${JSON.stringify(video)}`);
            s.codecs = [{ name: "opus", type: "audio", priority: 1000, payload_type: opusPt, rtx_payload_type: null }, ...video];
            asOurs(() => emit.call(conn, "connected", "webrtc", { sdp: trimmed, codecs: s.codecs }));
        },
        e => {
            debug(`${s.id} offer failed ${String(e?.message ?? e).slice(0, 300)}`);
            console.warn("[ChangeEndpoint] voice offer failed:", e);
        },
    );
}

// rory drops audio published during the join, publish it again once connected
function republish(s: Session) {
    s.op12 ??= { audio_ssrc: s.ssrc, video_ssrc: 0, rtx_ssrc: 0, streams: [] };
    setTimeout(() => {
        if (!sessions.has(s.id) || !s.op12) return;
        sendVoice(s, 12, { ...s.op12, audio_ssrc: 0 });
        setTimeout(() => {
            if (!sessions.has(s.id) || !s.op12) return;
            sendVoice(s, 12, s.op12);
            sendSpeaking(s);
        }, 1500);
    }, 2000);
}

function onVoiceMessage(ws: WebSocket, data: unknown) {
    if (typeof data !== "string") return;
    const payload = JSON.parse(data) as { op: number; d?: Record<string, any> };
    // Discord connects from its own op 2 handler, so the session is matched to its socket by ssrc right after
    if (payload.op === 2 && !sessionBySocket.has(ws)) {
        const s = [...sessions.values()].find(x => !x.ws && x.serverSsrc === payload.d?.ssrc);
        if (s) {
            s.ws = ws;
            sessionBySocket.set(ws, s);
        }
    }
    const s = sessionBySocket.get(ws);
    if (payload.op !== 6) debug(`${s?.id ?? "?"} recv op${payload.op} ${data.replace(/"(token|secret_key)":[^,}]+/g, "\"$1\":\"<h>\"").slice(0, 160)}`);
    if (!s) return;

    if (payload.op === 4 && payload.d?.sdp) {
        s.fragment = payload.d.sdp;
        applyAnswer(s);
    } else if (payload.op === 12 && payload.d?.user_id) {
        const { audio_ssrc, user_id, streams } = payload.d;
        const stream = (streams as { ssrc?: number; active?: boolean }[] | undefined)?.find(x => x.ssrc && x.active !== false);
        const videoSsrc = Number(payload.d.video_ssrc || stream?.ssrc || 0);
        const hasVideo = (ssrc: number) => [...s.video.values()].some(v => v.ssrc === ssrc);
        const newAudio = !!audio_ssrc && !s.users.has(audio_ssrc);
        const newVideo = !!videoSsrc && !hasVideo(videoSsrc);
        const videoGone = !videoSsrc && [...s.video.values()].some(v => v.userId === user_id);
        if (videoGone) stopVideo(s, user_id);
        if (!newAudio && !newVideo) {
            if (videoGone) applyAnswer(s);
            return;
        }
        run(s, async () => {
            if (newAudio && !s.users.has(audio_ssrc)) {
                s.localSdp = await native<string>("voice.addAudioReceiver", [s.id]);
                s.users.set(audio_ssrc, user_id);
            }
            if (newVideo) await bindVideo(s, videoSsrc, user_id);
        }).then(() => applyAnswer(s));
    } else if (payload.op === 13 && payload.d?.user_id) {
        stopVideo(s, payload.d.user_id);
    }
}

function rewriteOutgoing(ws: WebSocket, data: string) {
    if (data.startsWith("{\"op\":0,")) return data.replace(/"max_dave_protocol_version":\d+/, "\"max_dave_protocol_version\":0");
    const s = sessionBySocket.get(ws);
    if (!s || !/^\{"op":(1|5|12)[,}]/.test(data)) return data;
    const payload = JSON.parse(data) as { op: number; d: Record<string, any> };
    if (payload.op === 1) {
        if (payload.d.protocol !== "webrtc") return data;
        payload.d.codecs = s.codecs;
    } else if (payload.op === 12) {
        const audio = sends(s) && payload.d.audio_ssrc ? s.ssrc : 0;
        payload.d = { ...payload.d, audio_ssrc: audio, video_ssrc: 0, rtx_ssrc: 0, streams: [] };
        if (audio) s.op12 = payload.d;
    } else payload.d = { ...payload.d, ssrc: s.ssrc };
    const out = JSON.stringify(payload);
    debug(`${s.id} send op${payload.op} ${out.slice(0, 200)}`);
    return out;
}

export function patchVoice() {
    const unpatches: (() => unknown)[] = [];

    // custom servers have no DAVE, Discord treats op 4 without it as a downgrade and disconnects
    let rtcPatched = false;
    const patchRTCConnection = () => {
        if (rtcPatched) return;
        const conn = findByStoreName("RTCConnectionStore")?.getRTCConnection();
        if (!conn) return debug("no RTCConnection to patch");
        rtcPatched = true;
        // older builds (iOS 340) don't refuse downgrades at all
        if (typeof Object.getPrototypeOf(conn)._maybeRefuseDaveDowngrade !== "function") return;
        unpatches.push(
            instead("_maybeRefuseDaveDowngrade", Object.getPrototypeOf(conn), function (this: unknown, args: unknown[], orig: Function) {
                return state.endpoints ? false : orig.apply(this, args);
            }),
        );
    };

    // rory rarely passes our keyframe requests on, so the first frame of a stream can take longer than Discord's ready timeout
    const ours = (streamId: unknown) => typeof streamId === "string" && [...sessions.keys()].some(id => streamId.startsWith(`${id}-`));
    unpatches.push(
        intercept(payload => {
            if (payload.type === "VIDEO_STREAM_READY_TIMEOUT" && ours(payload.videoStreamId)) return false;
            if (payload.type === "REPORT_AV_ERROR" && payload.error === "video-stream-receiver-ready-timeout" && ours(payload.context?.videoStreamId)) return false;
        }),
    );

    const engineStore = findByStoreName("MediaEngineStore");
    const engine = Object.getPrototypeOf(engineStore.getMediaEngine());

    unpatches.push(
        instead("send", WebSocket.prototype, function (this: WebSocket, args: any[], send: Function) {
            const [data] = args;
            if (!state.endpoints) return send.apply(this, args);
            if (!sockets.has(this)) {
                if (typeof data !== "string" || !data.startsWith("{\"op\":0,\"d\":{\"server_id\"")) return send.apply(this, args);
                sockets.add(this);
                const ws = this;
                ws.addEventListener("message", e => onVoiceMessage(ws, e.data));
                ws.addEventListener("close", e => {
                    debug(`${sessionBySocket.get(ws)?.id ?? "?"} socket closed ${e.code} ${e.reason ?? ""}`);
                    sessionBySocket.delete(ws);
                });
            }
            return send.call(this, typeof data === "string" ? rewriteOutgoing(this, data) : data);
        }),
        before("setOutputVolume", engine, (args: any[]) => {
            if (state.endpoints) native("voice.setOutputVolume", [args[0]]).catch(() => {});
        }),
        after("connect", engine, (args: any[], conn: Connection) => {
            if (!state.endpoints) return conn;
            // take over first, Discord's own engine emits an unhandled error that crashes the app if it's left running
            takeOver(conn, String(args[0] ?? "default"), Number(args[2]?.ssrc ?? 0));
            try {
                patchRTCConnection();
            } catch (e) {
                debug(`dave patch failed ${String((e as Error)?.message ?? e)}`);
            }
            native("voice.setOutputVolume", [engineStore.getOutputVolume()]).catch(() => {});
            return conn;
        }),
    );

    return unpatches;
}
