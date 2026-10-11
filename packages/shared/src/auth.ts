export interface UserInfo {
  id: string
  username: string
  createdAt: number
}

export interface LoginRequest {
  username: string
  password: string
}

export interface SessionInfo {
  id: string
  expiresAt: number
}
