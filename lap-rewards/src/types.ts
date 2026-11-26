export type Role = 'student' | 'teacher' | 'admin';

export interface Env {
  DB: D1Database;
  BACKUPS: R2Bucket;
  ASSETS: Fetcher;
  /** Secret used once to create the first administrator. */
  SETUP_TOKEN?: string;
  BACKUP_RETENTION_DAYS?: string;
  PBKDF2_ITERATIONS?: string;
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
