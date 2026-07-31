import type {
  AuthRequest,
  AuthResponse,
  CreateGameRequest,
  CurrentUserResponse,
  GameView,
  JoinGameResponse,
  LogHealthProgressRequest,
  LogHealthProgressResponse,
  SendChatMessageResponse,
} from '../src/client/apiTypes.js';

export interface ApiErrorOptions {
  status?: number;
  code?: string;
  details?: unknown;
}

export class ApiError extends Error {
  constructor(message: string, options?: ApiErrorOptions);
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly isUnauthorized: boolean;
  readonly isStaleGame: boolean;
}

export type ApiFetch = (input: string, init?: Record<string, unknown>) => Promise<{
  ok: boolean;
  status: number;
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
}

export interface PostOptions extends Omit<RequestOptions, 'method' | 'body'> {
  revision?: number;
}

export interface HealthRiskApiClient {
  readonly baseUrl: string;
  setToken(value: string | null | undefined): void;
  request<T>(path: string, options?: RequestOptions): Promise<T>;
  get<T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T>;
  post<T>(path: string, body?: unknown, options?: PostOptions): Promise<T>;
  me(): Promise<CurrentUserResponse>;
  login(credentials: AuthRequest): Promise<AuthResponse>;
  signup(credentials: AuthRequest): Promise<AuthResponse>;
  logout(): Promise<{ ok: true }>;
  getGame(gameId: string): Promise<GameView>;
  createGame(input: CreateGameRequest): Promise<GameView>;
  joinGame(gameId: string): Promise<JoinGameResponse>;
  sendChatMessage(gameId: string, body: string): Promise<SendChatMessageResponse>;
  logHealthProgress(
    gameId: string,
    input: LogHealthProgressRequest,
    revision?: number,
  ): Promise<LogHealthProgressResponse>;
}

export function createApiClient(options?: ApiClientOptions): HealthRiskApiClient;
