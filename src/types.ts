export type Role = 'student' | 'teacher' | 'admin';

export interface Env {
  DB: D1Database;
  BACKUPS: R2Bucket;
  ASSETS: Fetcher;
  /** Secret used once to create the first administrator. */
  SETUP_TOKEN?: string;
  BACKUP_RETENTION_DAYS?: string;
  PBKDF2_ITERATIONS?: string;
  /** Optional Web Push (VAPID) key pair, base64url. When unset, a pair is generated once and kept in D1. */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  /** Optional contact sent to push services: a mailto: or https: URL. Defaults to this site's origin. */
  VAPID_SUBJECT?: string;
}

export interface SessionUser {
  id: number;
  login_id: string;
  nickname: string;
  role: Role;
  class_id: number | null;
  class_name: string | null;
  balance: number;
  must_change_password: number;
  token_hash: string;
}
