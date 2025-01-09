declare interface Authentication {
  id: number;
  authenticated: boolean;
}

declare interface Connection {
  id: number;
}

declare interface RateLimitOptions {
  maxRequests: number;
  time: number;
  maxWindowTime: number;
}

declare interface ClientRateLimit {
  id: string;
  requests: number;
  rateLimited: boolean;
  time: Nullable<number>;
  windowTime: number;
}
