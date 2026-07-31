import type {
  AuthRequest,
  AuthResponse,
  CreateGameRequest,
  CurrentUserResponse,
  GameView,
  ListGamesResponse,
  JoinGameResponse,
  LogHealthProgressRequest,
  LogHealthProgressResponse,
  SendChatMessageResponse,
  NotificationsResponse,
  DeviceRegistrationView,
} from '../src/client/apiTypes.js';

export interface ApiErrorOptions {
  status?: number;
  code?: string;
  details?: unknown;
  requestId?: string | null;
  retryable?: boolean;
}

export class ApiError extends Error {
  constructor(message: string, options?: ApiErrorOptions);
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly requestId: string | null;
  readonly retryable: boolean;
  readonly isUnauthorized: boolean;
  readonly isStaleGame: boolean;
}

export type ApiFetch = (input: string, init?: Record<string, unknown>) => Promise<{
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface ApiClientOptions {
  baseUrl?: string;
  token?: string | null;
  getToken?: () => string | null | undefined;
  credentials?: 'omit' | 'same-origin' | 'include';
  fetch?: ApiFetch;
  onStaleGame?: (error: ApiError) => void | Promise<void>;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: unknown;
  requestId?: string;
}

export interface PostOptions extends Omit<RequestOptions, 'method' | 'body'> {
  revision?: number;
  idempotencyKey?: string;
}

export interface HealthRiskApiClient {
  readonly baseUrl: string;
  setToken(value: string | null | undefined): void;
  request<T>(path: string, options?: RequestOptions): Promise<T>;
  get<T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T>;
  post<T>(path: string, body?: unknown, options?: PostOptions): Promise<T>;
  delete<T>(path: string, body?: unknown, options?: PostOptions): Promise<T>;
  me(): Promise<CurrentUserResponse>;
  login(credentials: AuthRequest): Promise<AuthResponse>;
  signup(credentials: AuthRequest): Promise<AuthResponse>;
  logout(): Promise<{ ok: true }>;
  deleteAccount(password: string): Promise<{ ok: true }>;
  listGames(): Promise<ListGamesResponse>;
  getGame(gameId: string): Promise<GameView>;
  createGame(input: CreateGameRequest): Promise<GameView>;
  joinGame(gameId: string): Promise<JoinGameResponse>;
  sendChatMessage(gameId: string, body: string): Promise<SendChatMessageResponse>;
  deleteChatMessage(gameId: string, messageId: string): Promise<{ ok: true }>;
  muteChatUser(gameId: string, userId: string): Promise<{ ok: true; mutedUserIds: string[] }>;
  unmuteChatUser(gameId: string, userId: string): Promise<{ ok: true; mutedUserIds: string[] }>;
  reportChatMessage(gameId: string, messageId: string, reason: string): Promise<{ ok: true; reportId: string }>;
  registerIosDevice(input: {
    token: string;
    environment: 'sandbox' | 'production';
  }): Promise<{ device: DeviceRegistrationView }>;
  listNotifications(): Promise<NotificationsResponse>;
  markNotificationRead(notificationId: string): Promise<{ ok: true }>;
  logHealthProgress(
    gameId: string,
    input: LogHealthProgressRequest,
    revision?: number,
  ): Promise<LogHealthProgressResponse>;
}

export function createApiClient(options?: ApiClientOptions): HealthRiskApiClient;
