/**
 * WebSocket close codes for the internal v1 channel (RFC §4.3, §5.1).
 * Codes 4000-4999 are application-defined. Every rejection closes the
 * connection before the handshake completes — no welcome is ever sent to a
 * connection that failed validation, so a rejected peer never gains
 * protocol access.
 */

export const CLOSE_CODES = {
  /** Wrong/missing token, wrong role, bad Host, or browser Origin. */
  UNAUTHORIZED: 4401,
  /** The broker is shutting down; the entry must re-probe later (RFC §4.3). */
  SHUTTING_DOWN: 4001,
  /** Entry presented a config digest different from the running instance. */
  CONFIG_MISMATCH: 4002,
  /** Peer built against a different build ID. */
  BUILD_MISMATCH: 4003,
  /** A bridge is already connected; one server environment at a time. */
  BRIDGE_ALREADY_CONNECTED: 4004,
  /** No hello arrived within the handshake window. */
  HANDSHAKE_TIMEOUT: 4005,
  /** No valid pong within the heartbeat loss threshold. */
  HEARTBEAT_LOST: 4006,
  /** Schema-invalid or directionally invalid message. */
  PROTOCOL_ERROR: 4007,
} as const;

export type CloseCode = (typeof CLOSE_CODES)[keyof typeof CLOSE_CODES];

export const CLOSE_REASONS = {
  UNAUTHORIZED: "unauthorized",
  SHUTTING_DOWN: "SHUTTING_DOWN",
  CONFIG_MISMATCH: "CONFIG_MISMATCH",
  BUILD_MISMATCH: "BUILD_MISMATCH",
  BRIDGE_ALREADY_CONNECTED: "BRIDGE_ALREADY_CONNECTED",
  HANDSHAKE_TIMEOUT: "HANDSHAKE_TIMEOUT",
  HEARTBEAT_LOST: "HEARTBEAT_LOST",
  PROTOCOL_ERROR: "PROTOCOL_ERROR",
} as const;
