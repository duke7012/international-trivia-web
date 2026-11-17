// File types the app serves and accepts as uploads. Shared by the Node server and Cloudflare.
export const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif",
  ".woff2": "font/woff2", ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".ogv": "video/ogg",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".flac": "audio/flac", ".ico": "image/x-icon",
};
export const UPLOAD_EXT = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".mp4", ".m4v", ".webm", ".mov", ".ogv", ".mp3", ".wav", ".ogg", ".oga", ".m4a", ".aac", ".flac"];
