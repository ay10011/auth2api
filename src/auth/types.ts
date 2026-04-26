export type ProviderId = "anthropic" | "codex";

export interface PKCECodes {
  codeVerifier: string;
  codeChallenge: string;
}

export interface TokenData {
  accessToken: string;
  refreshToken: string;
  email: string;
  expiresAt: string; // ISO 8601
  accountUuid: string; // anthropic: data.account.uuid; codex: chatgpt_account_id
  provider?: ProviderId; // missing on legacy files → treated as "anthropic"
  idToken?: string; // codex only
  /** ISO 8601 of last successful refresh (or initial token issuance). */
  lastRefreshAt?: string;
  /** Codex only — raw chatgpt_plan_type claim from id_token (free/plus/pro/…). */
  planType?: string;
}

export interface TokenStorage {
  access_token: string;
  refresh_token: string;
  last_refresh: string;
  email: string;
  type: ProviderId | "claude"; // "claude" retained for legacy files
  expired: string; // ISO 8601
  account_uuid?: string;
  id_token?: string;
  plan_type?: string;
}
