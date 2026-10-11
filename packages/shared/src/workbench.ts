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
