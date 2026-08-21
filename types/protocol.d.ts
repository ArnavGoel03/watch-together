/**
 * The wire protocol, defined exactly once.
 *
 * Four surfaces speak this: the content script, the overlay, the popup, and the
 * background service worker (in two flavours, Chrome MV3 and Firefox MV2), talking to two
 * server implementations (Node and the Cloudflare Durable Object port). Every one of them
 * used to carry its own idea of what a message looked like, and the resulting drift was
 * invisible until a user hit it:
 *
 *   - Firefox's create-room dropped `mode` and `customName`, so choosing "host only" did
 *     nothing at all on Firefox while the UI happily said otherwise.
 *   - Firefox's inbound switch had no case for `voice-signal`, so voice could never
 *     negotiate: it relayed outward and dropped everything coming back.
 *   - `currentTime` was guarded with isNaN, which lets Infinity through.
 *
 * None of those are hard bugs to find with types. They were hard to find without them.
 *
 * Nothing here is imported at runtime. The extension ships as plain JS with no build step;
 * these are referenced from JSDoc and read by `npm run typecheck`.
 */

/** Bumped when the shape of a message changes in a way an old client would misread. */
export type ProtocolVersion = 1;

export type RoomMode = "everyone" | "host";
export type SyncAction = "play" | "pause" | "seek" | "ratechange" | "resync";

export interface RoomMember {
  id: string;
  userName: string;
}

export interface PlaybackState {
  playing: boolean;
  /** Seconds. Always finite: Infinity is rejected at the server edge. */
  currentTime: number;
  /** Between 0.1 and 16. */
  playbackRate: number;
  lastUpdate?: number;
  timestamp?: number;
  serverTime?: number;
}

/** Fields the server stamps on most of what it sends. */
interface ServerStamped {
  /** Server clock, used by clients to correct for a skewed local clock. */
  serverTime?: number;
  v?: ProtocolVersion;
}

// ---------- client to server ----------

export interface CreateRoomMessage {
  type: "create-room";
  userName: string;
  videoUrl?: string;
  mode?: RoomMode;
  /** Opting into a memorable, reusable room name instead of a generated code. */
  customName?: string;
  v?: ProtocolVersion;
}

export interface JoinRoomMessage {
  type: "join-room";
  roomCode: string;
  userName?: string;
  /**
   * Set only by an automatic rejoin. The server keeps rooms in memory, so a restart wipes
   * them and a live party would all get "Room not found" at once; this lets a returning
   * member rebuild the room from the position they last saw.
   */
  recreateIfMissing?: boolean;
  resumeState?: PlaybackState;
  videoUrl?: string;
  mode?: RoomMode;
  /**
   * HMAC of the room code, issued to whoever created it. Proves the same person is coming
   * back so a reload does not silently cost them their own room, and stops a stranger
   * claiming host by rebuilding a room they merely know the code for.
   */
  hostToken?: string;
  v?: ProtocolVersion;
}

export interface SyncMessage {
  type: "sync";
  action?: SyncAction;
  playing: boolean;
  currentTime: number;
  playbackRate: number;
  /** Live streams carry no meaningful position: DVR offsets differ per viewer. */
  isLive?: boolean;
  v?: ProtocolVersion;
}

export interface HeartbeatMessage {
  type: "heartbeat";
  playing: boolean;
  currentTime: number;
  playbackRate: number;
  isLive?: boolean;
  v?: ProtocolVersion;
}

export interface NavigateMessage {
  type: "navigate";
  /** Always http: or https:. Validated on both the client and the server. */
  url: string;
  /** True when the party tab woke up somewhere else and wants the room to follow it. */
  onResume?: boolean;
  v?: ProtocolVersion;
}

export interface ChatMessage {
  type: "chat";
  message: string;
  v?: ProtocolVersion;
}

export type ClientMessage =
  | CreateRoomMessage
  | JoinRoomMessage
  | SyncMessage
  | HeartbeatMessage
  | NavigateMessage
  | ChatMessage
  | { type: "leave-room"; v?: ProtocolVersion }
  | { type: "request-state"; v?: ProtocolVersion }
  | { type: "set-mode"; mode: RoomMode; v?: ProtocolVersion }
  | { type: "chat-typing"; isTyping: boolean; v?: ProtocolVersion }
  | { type: "cc-state"; active: boolean; v?: ProtocolVersion }
  /**
   * Whether this viewer is currently sitting out an advert. Ads are per-viewer, so one
   * person's break is not the room's, but the server needs to know because when EVERY
   * member is in one it must stop the room's clock: the position is stored as
   * (currentTime, lastUpdate) and read by extrapolating forward, which assumes somebody
   * was watching. It also stops the sync-leader job going to someone who has deliberately
   * stopped broadcasting.
   */
  | { type: "ad-state"; active: boolean; v?: ProtocolVersion }
  | { type: "voice-state"; active: boolean; v?: ProtocolVersion }
  | { type: "voice-signal"; toUserId: string; signal: unknown; v?: ProtocolVersion };

// ---------- server to client ----------

export interface RoomCreatedMessage extends ServerStamped {
  type: "room-created";
  roomCode: string;
  userId: string;
  mode: RoomMode;
  persistent: boolean;
  isHost: true;
  /** Handed out once, to the creator only. */
  hostToken?: string;
}

export interface RoomJoinedMessage extends ServerStamped {
  type: "room-joined";
  roomCode: string;
  userId: string;
  mode: RoomMode;
  persistent?: boolean;
  isHost: boolean;
  videoUrl?: string;
  playbackState?: PlaybackState;
  members?: RoomMember[];
  /** Only ever returned to someone who already proved they hold it. */
  hostToken?: string;
  /** Set by the background when handing membership back to a reloaded party tab. */
  resumed?: boolean;
}

export interface ServerSyncMessage extends ServerStamped, PlaybackState {
  type: "sync";
  action?: SyncAction;
  fromUser?: string;
  fromUserId?: string;
  isLive?: boolean;
  videoUrl?: string;
}

export type ServerMessage =
  | RoomCreatedMessage
  | RoomJoinedMessage
  | ServerSyncMessage
  | ({ type: "heartbeat"; fromUserId?: string; isLive?: boolean } & ServerStamped & PlaybackState)
  | ({ type: "heartbeat-role"; isLeader: boolean } & ServerStamped)
  | ({ type: "member-joined"; userId: string; userName: string; memberCount: number } & ServerStamped)
  | ({ type: "member-left"; userId: string; userName: string; memberCount: number } & ServerStamped)
  | ({ type: "mode-changed"; mode: RoomMode; fromUser: string } & ServerStamped)
  | ({ type: "host-transferred"; isHost: boolean } & ServerStamped)
  | ({ type: "navigate"; url: string; fromUser?: string; fromUserId?: string } & ServerStamped)
  | ({ type: "chat"; message: string; userName: string; userId: string; timestamp: number } & ServerStamped)
  | ({ type: "chat-typing"; userId: string; userName: string; isTyping: boolean } & ServerStamped)
  | ({ type: "cc-state"; userId: string; userName: string; active: boolean } & ServerStamped)
  | ({
      type: "ad-state";
      userId: string;
      userName: string;
      active: boolean;
      /** How many members are watching the film rather than an advert. Zero means held. */
      watchingCount: number;
      memberCount: number;
    } & ServerStamped)
  | ({ type: "voice-state"; userId: string; userName: string; active: boolean; activeUserIds: string[] } & ServerStamped)
  | ({ type: "voice-signal"; fromUserId: string; fromUserName: string; signal: unknown } & ServerStamped)
  | ({ type: "error"; message: string } & ServerStamped);

// ---------- background to extension surfaces ----------
// Not on the wire: these only travel over chrome.runtime ports inside the browser.

export type InternalMessage =
  | { type: "connection-status"; connected: boolean }
  | { type: "room-ended"; reason: "left" | "moved" }
  | { type: "party-tab-closed"; roomCode: string | null }
  | { type: "party-tab-adopted"; roomCode: string | null }
  | { type: "send-failed"; of: string; message: string }
  | { type: "state"; currentRoom: string | null; userId: string | null; connected: boolean; isHeartbeatLeader: boolean; serverUrl: string; members: RoomMember[]; mode: RoomMode; isHost: boolean; partyTabId: number | null; hasPartyTab: boolean };

export type AnyMessage = ClientMessage | ServerMessage | InternalMessage;
