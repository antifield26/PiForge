export type TodoStatus = "open" | "done" | "archived"

export interface Todo {
  id: string
  title: string
  notes: string | null
  status: TodoStatus
  dueAt: number | null
  createdAt: number
  updatedAt: number
}

export interface Note {
  id: string
  title: string
  body: string
  tags: string[]
  createdAt: number
  updatedAt: number
}

export interface Bookmark {
  id: string
  url: string
  title: string | null
  folder: string | null
  createdAt: number
}

export interface ApiError {
  error: {
    code: string
    message: string
  }
}

/** Row shape of backup_runs (snake_case mirrors the DB column names). */
export interface BackupRun {
  id: number
  started_at: number
  finished_at: number | null
  status: string
  target: string
  bytes: number | null
  checksum: string | null
  message: string | null
}

export interface CloudFile {
  id: string
  name: string
  size: number
  mime?: string | null
  createdAt: number
  versions?: number
}
