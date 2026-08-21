/**
 * Ambient declarations for the globals the extension passes between its own files.
 *
 * These files are classic scripts, not modules: they cannot import from each other, so
 * they hand things over on `window` (content scripts all share one isolated world, which
 * the host page cannot see) and on `self` in the service worker. Declaring them here is
 * what lets `npm run typecheck` follow those handovers instead of reporting every one as
 * a property that does not exist.
 */

import type { RoomMode } from "./protocol";

interface WatchTogetherAdapter {
  /** Which site this adapter is for. Diagnostic only. */
  name?: string;
  findVideo?(): HTMLVideoElement | null;
  applyState?(video: HTMLVideoElement, state: Record<string, any>): void;
}

interface WatchTogetherConfig {
  PROTOCOL_VERSION: 1;
  /** Relays in priority order. SERVER_URL is the head of this list, not a second copy. */
  SERVER_URLS: string[];
  SERVER_URL: string;
  HTTP_ORIGIN: string;
  SAFE_NAVIGATE_PROTOCOLS: string[];
  ROOM_CODE_REGEX: RegExp;
  CUSTOM_NAME_REGEX: RegExp;
  isJoinableCode(code: unknown): boolean;
  isSafeNavigateUrl(raw: unknown): boolean;
  /** A relay we are willing to talk to: wss only, never plaintext. */
  isValidServerUrl(raw: unknown): boolean;
}

/** Chooses which relay to talk to, and where to go when one stops answering. */
declare class RelayPicker {
  override: string | null;
  moved: string | null;
  index: number;
  failures: number;
  maxFailuresPerCandidate: number;
  candidates(): string[];
  current(): string;
  onConnected(): void;
  /** True when it gave up on the current relay and moved to the next one. */
  onFailure(): boolean;
  /** True when the move was accepted; a bad, repeated or self-referential URL is refused. */
  acceptMove(url: unknown): boolean;
  setOverride(url: unknown): string | null;
  hydrate(stored?: { serverUrl?: unknown; movedServerUrl?: unknown }): void;
}

interface WatchTogetherRelayModule {
  RelayPicker: typeof RelayPicker;
}

/** The handle content.js exposes so overlay.js can read sync health without a round trip. */
interface WatchTogetherCore {
  resync(): void;
  isInRoom(): boolean;
  /** Seconds behind (+) or ahead (-), or null when the reading is too old to trust. */
  getDrift(): number | null;
  /** Seconds this viewer's copy runs ahead of the room's timeline. */
  setOffset(seconds: number): void;
  getOffset(): number;
}

declare global {
  interface Window {
    __watchTogetherLoaded?: boolean;
    __watchTogetherOverlayLoaded?: boolean;
    __watchTogetherAdapters?: Record<string, WatchTogetherAdapter>;
    __wtConfig: WatchTogetherConfig;
    __wtRelay: WatchTogetherRelayModule;
    __wtCore?: WatchTogetherCore;
  }

  // The MV3 service worker and the Firefox background page both reach these via `self`.
  var __wtConfig: WatchTogetherConfig;
  var __wtRelay: WatchTogetherRelayModule;

  /** Classic-script loader, available in the MV3 service worker. */
  function importScripts(...urls: string[]): void;

  interface ServiceWorkerGlobalScope {
    __wtConfig: WatchTogetherConfig;
  }

  // Populated by config.js in whichever scope it is loaded into.
  var __watchTogetherAdapters: Record<string, WatchTogetherAdapter> | undefined;

  type WtRoomMode = RoomMode;
}

export {};
