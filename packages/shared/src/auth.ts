export interface UserInfo {
  id: string
  username: string
  createdAt: number
}

export interface LoginRequest {
  username: string
  password: string
}

/** Shape of `POST /api/v1/auth/login` success body. */
export interface LoginResponse {
  user: { id: string; username: string }
  expiresAt: number
}

/** Max accepted binary upload size for the workbench cloud (gateway bodyLimit is higher
 *  to allow base64 overhead). Keep in sync with apps/web CloudPanel. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024
