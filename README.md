# Cfxhtp

A Cloudflare Worker implementation of VLESS proxy with xhttp transport and gRPC support.

## Features

- VLESS protocol with xhttp transport
- gRPC-compatible headers for CDN compatibility
- Support for custom subdomains and worker routes
- Works as an origin server behind CDNs (Vercel, Bunny, etc.)
- HTTP/2 and HTTP/1.1 support

## Configuration

Set the following environment variables in your Cloudflare Worker:

- `UUID`: Your VLESS UUID (required)
- `PROXY`: Optional reverse proxy for CF websites (e.g., example.com)
- `LOG_LEVEL`: Logging level (debug, info, error, none) - default: info

## Usage

### Direct Connection

Deploy the worker and access it directly at `https://your-worker.workers.dev`

### Behind CDN

This worker is designed to work as an origin server behind CDNs like Vercel or Bunny:

```
Client → Vercel/Bunny CDN → Cloudflare Worker (this)
```

The worker includes:
- Proper gRPC headers (`application/grpc+proto`)
- Cache control headers to prevent CDN buffering
- CORS support via OPTIONS method
- HTTP/2 ALPN support with HTTP/1.1 fallback

### Getting Configuration

Access `https://your-worker.workers.dev/?config=<UUID>` or include the UUID in the path to get the xray/v2ray configuration JSON.

## Client Configuration

The worker generates a configuration compatible with xray-core/v2ray-core clients. Key settings:

- Protocol: VLESS
- Network: xhttp
- Mode: stream-one
- Security: TLS
- ALPN: h2, http/1.1

## How It Works

1. Client sends POST request with VLESS protocol data
2. Worker parses VLESS header and extracts destination
3. Worker connects to destination using Cloudflare sockets
4. Bidirectional streaming between client and destination
5. Connection statistics logged on completion