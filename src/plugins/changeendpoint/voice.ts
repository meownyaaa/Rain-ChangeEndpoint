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
}

interface Session {
    conn: Connection;
    ssrc: number;
    localSdp: string;
    fragment?: string;
    users: Map<number, string>;
    op12?: Record<string, unknown>;
    codecs: Record<string, unknown>[];
    queue: Promise<unknown>;
    muted: boolean;
}

let session: Session | null = null;
const sockets = new WeakSet<WebSocket>();
const liveSockets = new Set<WebSocket>();

// mobile never sends op 12/op 5 for our transport, so the server wouldn't forward our audio
const sendVoice = (op: number, d: Record<string, unknown>) => {
    for (const ws of liveSockets) if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op, d }));
};
const sendSpeaking = (s: Session) => sendVoice(5, { speaking: s.muted ? 0 : 1, delay: 0, ssrc: s.ssrc });

const debugLog: string[] = ((globalThis as { __ceVoiceLog?: string[] }).__ceVoiceLog = []);
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

const VIDEO_CODECS = [
    { name: "H264", type: "video", priority: 1000, payload_type: 103, rtx_payload_type: 104 },
    { name: "VP8", type: "video", priority: 2000, payload_type: 96, rtx_payload_type: 97 },
    { name: "VP9", type: "video", priority: 3000, payload_type: 98, rtx_payload_type: 99 },
];

function trimOffer(sdp: string) {
    const [first] = sections(sdp);
    const head = sdp.split(/\r?\nm=/)[0];
    const pick = (name: string) => sdpAttrs(first, name)[0] ?? sdpAttrs(head, name)[0];
    const opus = sdpAttrs(first, "rtpmap").find(r => r.includes("opus/48000"));
    const lines = [
        "a=extmap-allow-mixed",
        `a=ice-ufrag:${pick("ice-ufrag")}`,
        `a=ice-pwd:${pick("ice-pwd")}`,
        "a=ice-options:trickle",
        `a=fingerprint:${pick("fingerprint")}`,
        ...sdpAttrs(first, "extmap").map(e => `a=extmap:${e}`),
        `a=rtpmap:${opus}`,
        ...VIDEO_CODECS.flatMap(c => [`a=rtpmap:${c.payload_type} ${c.name}/90000`, `a=rtpmap:${c.rtx_payload_type} rtx/90000`]),
    ];
    return { sdp: lines.join("\n"), opusPt: Number(opus?.split(" ")[0] ?? 111) };
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
    const pt = trimOffer(s.localSdp).opusPt;

    const media = local.map((_, i) => {
        const user = i === 0 ? undefined : users[i - 1];
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
            i === 0 ? "a=recvonly" : user ? "a=sendonly" : "a=inactive",
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

const applyAnswer = (s: Session) =>
    run(s, async () => {
        const answer = buildAnswer(s);
        if (!answer) return debug("answer skipped, no fragment");
        debug(`answer apply users=${s.users.size}`);
        await native("voice.answer", [answer]);
        debug("answer applied");
    });

let engineHandler: { onEngineState(value: string): void } | null = null;

// the tweak queues engine events, they're polled while a call is up
let polling: ReturnType<typeof setInterval> | null = null;
function pollEvents(on: boolean) {
    if (!on) {
        if (polling) clearInterval(polling);
        polling = null;
        return;
    }
    polling ??= setInterval(async () => {
        let events: [string, string][];
        try {
            events = await native<[string, string][]>("events");
        } catch {
            return;
        }
        for (const [type, value] of events) {
            debug(`engine ${type}=${value}`);
            if (type !== "connection") continue;
            engineHandler?.onEngineState(value);
            if (value === "CONNECTED" && session) republish(session);
        }
    }, 300);
}

function takeOver(conn: Connection) {
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
    conn.setConnectionState = function (value) {
        if (ours) setConnectionState.call(this, value);
    };
    conn.emit = function (event, ...args) {
        if (!ours && (event === "error" || event === "connectionstatechange")) return;
        return emit.call(this, event, ...args);
    };
    conn.setSDP = () => {};
    conn.setSelfMute = function (muted) {
        native("voice.setMuted", [!!muted]).catch(() => {});
        if (session?.conn === conn && session.muted !== !!muted) {
            session.muted = !!muted;
            sendSpeaking(session);
        }
        return setSelfMute.call(this, muted);
    };
    conn.setSelfDeaf = function (deafened) {
        native("voice.setDeafened", [!!deafened]).catch(() => {});
        return setSelfDeaf.call(this, deafened);
    };
    conn.destroy = function () {
        if (session?.conn === conn) session = null;
        pollEvents(false);
        native("voice.close").catch(() => {});
        return destroy.call(this);
    };

    asOurs(() => setConnectionState.call(conn, "CONNECTING"));
    pollEvents(true);

    native<string>("voice.offer").then(
        sdp => {
            const ssrc = Number(sdp.match(/a=ssrc:(\d+)/)?.[1] ?? 0);
            const { sdp: trimmed, opusPt } = trimOffer(sdp);
            const codecs = [{ name: "opus", type: "audio", priority: 1000, payload_type: opusPt, rtx_payload_type: null }, ...VIDEO_CODECS];
            const s: Session = { conn, ssrc, localSdp: sdp, users: new Map(), queue: Promise.resolve(), codecs, muted: false };
            session = s;
            asOurs(() => emit.call(conn, "connected", "webrtc", { sdp: trimmed, codecs }));
        },
        e => {
            debug(`offer failed ${String(e?.message ?? e).slice(0, 300)}`);
            console.warn("[ChangeEndpoint] voice offer failed:", e);
        },
    );

    return {
        onEngineState(value: string) {
            if (value === "CONNECTED") asOurs(() => setConnectionState.call(conn, "CONNECTED"));
            else if (value === "FAILED" || value === "CLOSED") asOurs(() => setConnectionState.call(conn, "DISCONNECTED"));
        },
    };
}

// rory drops audio published during the join, publish it again once connected
function republish(s: Session) {
    s.op12 ??= { audio_ssrc: s.ssrc, video_ssrc: 0, rtx_ssrc: 0, streams: [] };
    setTimeout(() => {
        if (session !== s || !s.op12) return;
        sendVoice(12, { ...s.op12, audio_ssrc: 0 });
        setTimeout(() => {
            if (session !== s || !s.op12) return;
            sendVoice(12, s.op12);
            sendSpeaking(s);
        }, 1500);
    }, 2000);
}

function onVoiceMessage(data: unknown) {
    const s = session;
    if (typeof data !== "string") return;
    const payload = JSON.parse(data) as { op: number; d?: Record<string, any> };
    if (payload.op !== 6) debug(`recv op${payload.op} session=${!!s} ${data.replace(/"(token|secret_key)":[^,}]+/g, "\"$1\":\"<h>\"").slice(0, 160)}`);
    if (!s) return;

    if (payload.op === 4 && payload.d?.sdp) {
        s.fragment = payload.d.sdp;
        applyAnswer(s);
    } else if (payload.op === 12 && payload.d?.audio_ssrc && payload.d.user_id && !s.users.has(payload.d.audio_ssrc)) {
        const { audio_ssrc, user_id } = payload.d;
        run(s, async () => {
            if (s.users.has(audio_ssrc)) return;
            s.localSdp = await native<string>("voice.addAudioReceiver");
            s.users.set(audio_ssrc, user_id);
        }).then(() => applyAnswer(s));
    }
}

function rewriteOutgoing(data: string) {
    if (data.startsWith("{\"op\":0,")) return data.replace(/"max_dave_protocol_version":\d+/, "\"max_dave_protocol_version\":0");
    const s = session;
    if (!s || !/^\{"op":(1|5|12)[,}]/.test(data)) return data;
    const payload = JSON.parse(data) as { op: number; d: Record<string, any> };
    if (payload.op === 1) {
        if (payload.d.protocol !== "webrtc") return data;
        payload.d.codecs = s.codecs;
    } else if (payload.op === 12) {
        payload.d = { ...payload.d, audio_ssrc: payload.d.audio_ssrc ? s.ssrc : 0, video_ssrc: 0, rtx_ssrc: 0, streams: [] };
        if (payload.d.audio_ssrc) s.op12 = payload.d;
    } else payload.d = { ...payload.d, ssrc: s.ssrc };
    const out = JSON.stringify(payload);
    debug(`send op${payload.op} ${out.slice(0, 200)}`);
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

    const engineStore = findByStoreName("MediaEngineStore");
    const engine = Object.getPrototypeOf(engineStore.getMediaEngine());

    unpatches.push(
        instead("send", WebSocket.prototype, function (this: WebSocket, args: any[], send: Function) {
            const [data] = args;
            if (!state.endpoints) return send.apply(this, args);
            if (!sockets.has(this)) {
                if (typeof data !== "string" || !data.startsWith("{\"op\":0,\"d\":{\"server_id\"")) return send.apply(this, args);
                sockets.add(this);
                liveSockets.add(this);
                const ws = this;
                ws.addEventListener("message", e => onVoiceMessage(e.data));
                ws.addEventListener("close", () => liveSockets.delete(ws));
            }
            return send.call(this, typeof data === "string" ? rewriteOutgoing(data) : data);
        }),
        before("setOutputVolume", engine, (args: any[]) => {
            if (state.endpoints) native("voice.setOutputVolume", [args[0]]).catch(() => {});
        }),
        after("connect", engine, (_: any[], conn: Connection) => {
            if (!state.endpoints) return conn;
            debug("connect intercepted");
            // take over first, Discord's own engine emits an unhandled error that crashes the app if it's left running
            engineHandler = takeOver(conn);
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
