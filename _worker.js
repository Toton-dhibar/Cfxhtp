import { connect } from 'cloudflare:sockets'

// configurations
const UUID = 'ed8891e9-5492-4f93-8a86-44bc845e8a4c' // vless UUID
const PROXY = '' // (optional) reverse proxy for CF websites. e.g. example.com
const LOG_LEVEL = 'info' // debug, info, error, none

// source code
const TIME_ZONE = 8 * 60 * 60 * 1000 // logging timestamp forwards 8 hours
const BUFFER_SIZE = 4 * 1024 // download/upload buffer size in bytes

function to_size(size) {
    const KiB = 1024
    const min = 1.1 * KiB
    let i = 0
    const SIZE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
    for (; i < SIZE_UNITS.length; i++) {
        if (size < min) {
            break
        }
        size = size / KiB
    }
    return `${Math.floor(size)} ${SIZE_UNITS[i]}`
}

function validate_uuid(id, uuid) {
    for (let index = 0; index < 16; index++) {
        const v = id[index]
        const u = uuid[index]
        if (v !== u) {
            return false
        }
    }
    return true
}

class Counter {
    #total

    constructor() {
        this.#total = 0
    }

    get() {
        return this.#total
    }

    add(size) {
        this.#total += size
    }
}

function concat_typed_arrays(first, ...args) {
    let len = first.length
    for (let a of args) {
        len += a.length
    }
    const r = new first.constructor(len)
    r.set(first, 0)
    len = first.length
    for (let a of args) {
        r.set(a, len)
        len += a.length
    }
    return r
}

class Logger {
    #id
    #level

    constructor(log_level) {
        this.#id = random_id()

        if (typeof log_level !== 'string') {
            log_level = 'info'
        }
        const levels = ['debug', 'info', 'error', 'none']
        this.#level = levels.indexOf(log_level.toLowerCase())
    }

    debug(...args) {
        if (this.#level < 1) {
            this.#log(`[debug]`, ...args)
        }
    }

    info(...args) {
        if (this.#level < 2) {
            this.#log(`[info ]`, ...args)
        }
    }

    error(...args) {
        if (this.#level < 3) {
            this.#log(`[error]`, ...args)
        }
    }

    #log(prefix, ...args) {
        const now = new Date(Date.now() + TIME_ZONE).toISOString()
        console.log(now, prefix, `(${this.#id})`, ...args)
    }
}

function random_id() {
    const min = 10000
    const max = min * 10 - 1
    return Math.floor(Math.random() * (max - min + 1)) + min
}

function parse_uuid(uuid) {
    uuid = uuid.replaceAll('-', '')
    const r = []
    for (let index = 0; index < 16; index++) {
        const v = parseInt(uuid.substr(index * 2, 2), 16)
        r.push(v)
    }
    return r
}

function get_buffer(size) {
    return new Uint8Array(new ArrayBuffer(size || BUFFER_SIZE))
}

// enums
const ADDRESS_TYPE_IPV4 = 1
const ADDRESS_TYPE_URL = 2
const ADDRESS_TYPE_IPV6 = 3

async function read_vless_header(readable, uuid_str) {
    const reader = readable.getReader({ mode: 'byob' })

    let r = await reader.readAtLeast(1 + 16 + 1, get_buffer())
    let rlen = 0
    let idx = 0
    let cache = r.value
    rlen += r.value.length

    const version = cache[0]
    const id = cache.slice(1, 1 + 16)
    const uuid = parse_uuid(uuid_str)
    if (!validate_uuid(id, uuid)) {
        return `invalid UUID`
    }
    const pb_len = cache[1 + 16]
    const addr_plus1 = 1 + 16 + 1 + pb_len + 1 + 2 + 1

    if (addr_plus1 + 1 > rlen) {
        if (r.done) {
            return `header too short`
        }
        idx = addr_plus1 + 1 - rlen
        r = await reader.readAtLeast(idx, get_buffer())
        rlen += r.value.length
        cache = concat_typed_arrays(cache, r.value)
    }

    const cmd = cache[1 + 16 + 1 + pb_len]
    if (cmd !== 1) {
        return `unsupported command: ${cmd}`
    }
    const port = (cache[addr_plus1 - 1 - 2] << 8) + cache[addr_plus1 - 1 - 1]
    const atype = cache[addr_plus1 - 1]
    let header_len = -1
    if (atype === ADDRESS_TYPE_IPV4) {
        header_len = addr_plus1 + 4
    } else if (atype === ADDRESS_TYPE_IPV6) {
        header_len = addr_plus1 + 16
    } else if (atype === ADDRESS_TYPE_URL) {
        header_len = addr_plus1 + 1 + cache[addr_plus1]
    }

    if (header_len < 0) {
        return 'read address type failed'
    }

    idx = header_len - rlen
    if (idx > 0) {
        if (r.done) {
            return `read address failed`
        }
        r = await reader.readAtLeast(idx, get_buffer())
        rlen += r.value.length
        cache = concat_typed_arrays(cache, r.value)
    }

    let hostname = ''
    idx = addr_plus1
    switch (atype) {
        case ADDRESS_TYPE_IPV4:
            hostname = cache.slice(idx, idx + 4).join('.')
            break
        case ADDRESS_TYPE_URL:
            hostname = new TextDecoder().decode(
                cache.slice(idx + 1, idx + 1 + cache[idx]),
            )
            break
        case ADDRESS_TYPE_IPV6:
            hostname = cache
                .slice(idx, idx + 16)
                .reduce(
                    (s, b2, i2, a) =>
                        i2 % 2
                            ? s.concat(((a[i2 - 1] << 8) + b2).toString(16))
                            : s,
                    [],
                )
                .join(':')
            break
    }

    if (hostname.length < 1) {
        return 'failed to parse hostname'
    }

    const data = cache.slice(header_len)
    return {
        hostname,
        port,
        data,
        resp: new Uint8Array([version, 0]),
        reader,
        done: r.done,
    }
}

async function upload_to_remote(counter, log, writer, vless) {
    async function inner_upload(d, src) {
        if (!d) {
            log.debug(`upload detect null ${src}`)
        }
        counter.add(d.length)
        log.debug(`upload ${src}: ${to_size(d.length)}`)
        await writer.write(d)
    }

    inner_upload(vless.data, 'first packet')
    while (!vless.done) {
        const r = await vless.reader.read(get_buffer())
        await inner_upload(r.value, 'remain packets')
        vless.done = r.done
    }
}

function create_uploader(log, vless, writable) {
    const counter = new Counter()
    const done = new Promise((resolve, reject) => {
        const writer = writable.getWriter()
        upload_to_remote(counter, log, writer, vless)
            .then(resolve)
            .catch(reject)
            .finally(() => {
                writer
                    .close()
                    .then(() => log.debug(`upload writer closed`))
                    .catch((err) => log.debug(`upload writer error: ${err}`))
            })
    })

    return {
        counter,
        done,
    }
}

function create_downloader(log, resp, remote_readable) {
    const counter = new Counter()
    let stream

    const done = new Promise((resolve, reject) => {
        stream = new TransformStream(
            {
                start(controller) {
                    log.debug(`copy vless response`)
                    counter.add(resp.length)
                    controller.enqueue(resp)
                },
                transform(chunk, controller) {
                    counter.add(chunk.length)
                    controller.enqueue(chunk)
                    log.debug(`download: ${to_size(chunk.length)}`)
                },
                cancel(reason) {
                    reject(`download cancelled: ${reason}`)
                },
            },
            null,
            new ByteLengthQueuingStrategy({ highWaterMark: BUFFER_SIZE }),
        )
        remote_readable.pipeTo(stream.writable).catch(reject).finally(resolve)
    })

    return {
        readable: stream.readable,
        counter,
        done,
    }
}

async function connect_to_remote(log, vless, ...remotes) {
    const hostname = remotes.shift()
    if (!hostname || hostname.length < 1) {
        log.info('all attempts failed')
        return null
    }

    if (vless.hostname === hostname) {
        log.info(`direct connect [${vless.hostname}]:${vless.port}`)
    } else {
        log.info(`proxy [${vless.hostname}]:${vless.port} through ${hostname}`)
    }

    const retry = () => connect_to_remote(log, vless, ...remotes)
    let remote
    try {
        remote = connect({ hostname: hostname, port: vless.port })
        const info = await remote.opened
        log.debug(`connection opened:`, info)
    } catch (err) {
        log.error(`retry [${vless.hostname}] reason: ${err}`)
        return await retry()
    }

    const uploader = create_uploader(log, vless, remote.writable)
    const downloader = create_downloader(log, vless.resp, remote.readable)
    return {
        downloader,
        uploader,
    }
}

async function handle_xhttp_client(log, body, cfg) {
    const vless = await read_vless_header(body, cfg.UUID)
    if (typeof vless !== 'object' || !vless) {
        // to-do: drain connection
        log.error(`failed to parse vless header: ${vless}`)
        return null
    }

    const r = await connect_to_remote(log, vless, vless.hostname, cfg.PROXY)
    if (r === null) {
        log.error('create remote stream failed')
        return null
    }

    const connection_closed = new Promise((resolve, _) => {
        r.downloader.done
            .then(() => log.debug(`download complete`))
            .catch((err) => log.error(`download error: ${err}`))
            .finally(() => r.uploader.done)
            .then(() => log.debug(`upload complete`))
            .catch((err) => log.debug(`upload error: ${err}`))
            .finally(() => {
                const total_upload = to_size(r.uploader.counter.get())
                const total_download = to_size(r.downloader.counter.get())
                log.info(
                    `connection closed. uploaded: ${total_upload} downloaded: ${total_download}`,
                )
                resolve()
            })
    })

    return {
        readable: r.downloader.readable,
        closed: connection_closed,
    }
}

async function handle_post(request, cfg) {
    const log = new Logger(cfg.LOG_LEVEL)
    try {
        return await handle_xhttp_client(log, request.body, cfg)
    } catch (err) {
        log.error(`error: ${err}`)
    }
    return null
}

function create_config(url, uuid) {
    const config = JSON.parse(config_template)
    const vless = config['outbounds'][0]['settings']['vnext'][0]
    const stream = config['outbounds'][0]['streamSettings']

    // workers are TLS only!
    const host = url.hostname
    const path = url.pathname
    vless['address'] = host
    vless['users'][0]['id'] = uuid
    stream['xhttpSettings']['host'] = host
    stream['xhttpSettings']['path'] = path.endsWith('/') ? path : `${path}/`
    stream['tlsSettings']['serverName'] = host

    return JSON.stringify(config)
}

const config_template = `{
  "log": {
    "loglevel": "warning"
  },
  "inbounds": [
    {
      "tag": "agentin",
      "port": 1080,
      "listen": "127.0.0.1",
      "protocol": "socks",
      "settings": {}
    }
  ],
  "outbounds": [
    {
      "protocol": "vless",
      "settings": {
        "vnext": [
          {
            "address": "localhost",
            "port": 443,
            "users": [
              {
                "id": "",
                "encryption": "none"
              }
            ]
          }
        ]
      },
      "tag": "agentout",
      "streamSettings": {
        "network": "xhttp",
        "xhttpSettings": {
          "mode": "stream-one",
          "host": "localhost",
          "path": "/",
          "noGRPCHeader": false,
          "keepAlivePeriod": 300
        },
        "security": "tls",
        "tlsSettings": {
          "serverName": "localhost",
          "alpn": [
            "h2",
            "http/1.1"
          ],
          "allowInsecure": false
        }
      }
    }
  ]
}`

async function fetch(request, env, ctx) {
    const cfg = {
        UUID: env.UUID || UUID,
        PROXY: env.PROXY || PROXY,
        LOG_LEVEL: env.LOG_LEVEL || LOG_LEVEL,
    }

    if (!cfg.UUID) {
        return new Response(`Error: UUID is empty`)
    }

    if (request.method === 'POST') {
        const r = await handle_post(request, cfg)
        if (r) {
            ctx.waitUntil(r.closed)
            
            // Build headers that work with CDNs and gRPC
            const headers = {
                'Content-Type': 'application/grpc+proto',
                'X-Accel-Buffering': 'no',
                'Cache-Control': 'no-store',
                'grpc-accept-encoding': 'identity,deflate,gzip',
                'accept-encoding': 'identity,gzip',
            }
            
            return new Response(r.readable, {
                status: 200,
                headers: headers,
            })
        }
        return new Response('Connection failed', {
            status: 503,
            headers: {
                'Content-Type': 'application/grpc+proto',
                'grpc-status': '14',
                'grpc-message': 'Connection unavailable',
            },
        })
    }

    if (request.method === 'GET') {
        const url = new URL(request.url)
        const items = [url.pathname, url.search]
        for (let item of items) {
            if (item.indexOf(`${cfg.UUID}`) >= 0) {
                const config = create_config(url, cfg.UUID)
                return new Response(config, {
                    headers: {
                        'Content-Type': 'application/json',
                    },
                })
            }
        }
    }
    return new Response(`Hello world!`)
}

export default {
    fetch,

    // for unit testing
    parse_uuid,
    validate_uuid,
    concat_typed_arrays,
}
