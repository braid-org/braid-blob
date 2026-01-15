# Braid-Blob

A library for synchronizing binary blobs (files, images, etc.) consistently over [Braid-HTTP](https://braid.org).  Guarantees all peers (HTTP clients and servers) resolve to the same version of blob.

Blobs can be read written locally, or over the network.  
Blobs are stored on disk in a folder.

## Quick Start

Install this library in your Javascript project:

```bash
npm install braid-blob
```

And now use it to serve HTTP requests with:

```javascript
// Create a HTTP server
require('http').createServer((req, res) => {

    // At any point, use braid-blob to respond to any GET, PUT, or DELETE request
    require('braid-blob').serve(req, res)

}).listen(8888)
```

That's it! You are now serving synchronized binary blobs at http://localhost:8888/*.

Upload an image to it:

```bash
curl -X PUT -H "Content-Type: image/png" -T blob.png http://localhost:8888/blob.png
```

You can view it at http://localhost:8888/blob.png.  
A browser client is described below.

## Interactive Demo

Run the demo web server with:

```shell
node server-demo.js
```

Now open up http://localhost:8888 in your browser, to see the client.  Open two windows.  You can drag and drop images between them, and they will always stay synchronized.

<video src="https://github.com/user-attachments/assets/9416e06b-143a-4b3a-a840-b6484f2571b1" controls width="600"></video>

## Network API

Braid-blob speaks [Braid-HTTP](https://github.com/braid-org/braid-spec), an extension to HTTP for synchronization.

### Special Braid-HTTP Headers

| Header | Description |
|--------|-------------|
| `Version` | Unique identifier for this version of the blob (e.g., `"1768467700000"`) |
| `Version-Type` | How to interpret the structure of version strings (e.g., `relative-wallclock`); see [Version-Type spec](https://github.com/braid-org/braid-spec/blob/master/draft-toomim-httpbis-versions-03.txt) |
| `Parents` | The previous version |
| `Merge-Type` | How conflicts resolve consistently (*e.g.* `aww` for [arbitrary-writer-wins](https://braid.org/protocol/merge-types/aww)) |
| `Subscribe` | In GET, subscribes client to all future changes |
| `Accept-Subscribe` | Server indicates it supports subscriptions |
| `Current-Version` | The latest version that the server is aware of |

### GET retrieves a blob

```http
GET /blob.png HTTP/1.1
```

Response:

```http
HTTP/1.1 200 OK
Version: "1768467700000"
Version-Type: relative-wallclock
Content-Type: image/png
Merge-Type: aww
Accept-Subscribe: true
Content-Length: 12345

<binary data>
```

Returns `404 Not Found` if the blob doesn't exist.

### GET with Subscribe syncs client with realtime updates

Add `Subscribe: true` to receive updates whenever the blob changes:

```http
GET /blob.png HTTP/1.1
Subscribe: true
```

Response (keeps connection open, streams updates):

```http
HTTP/1.1 209 Multiresponse
Subscribe: true
Current-Version: "1768467700000"
Version-Type: relative-wallclock

HTTP 200 OK
Version: "1768467700000"
Version-Type: relative-wallclock
Content-Type: image/png
Merge-Type: aww
Content-Length: 12345

<binary data>

HTTP 200 OK
Version: "1768467701000"
Version-Type: relative-wallclock
Content-Type: image/png
Merge-Type: aww
Content-Length: 23456

<new binary data>
...
```

If the blob doesn't exist yet, `Current-Version` will be blank and no initial update is sent. If the blob is deleted, a `404` update is streamed.

### PUT stores a blob

```http
PUT /blob.png HTTP/1.1
Version: "1768467702000"
Version-Type: relative-wallclock
Content-Type: image/png
Merge-Type: aww
Content-Length: 34567

<binary data>
```

Response:

```http
HTTP/1.1 200 OK
Current-Version: "1768467702000"
Version-Type: relative-wallclock
```

If the sent version is older or eclipsed by the server's current version, the returned `Current-Version` will be the server's version (not the one you sent).

The `braid_blob.serve()` method (below) will accept every PUT sent to it, but you can implement access control for any request before passing it to `serve()`, and return e.g. `401 Unauthorized` if you do no want to allow the PUT.

### DELETE removes a blob

```http
DELETE /blob.png HTTP/1.1
```

Response:

```http
HTTP/1.1 200 OK
```

Returns `200 OK` even if the blob didn't exist.

### Understanding versions

Versions are timestamps representing milliseconds past the epoch (e.g., `"1768467700000"`). If the current time is less than the latest known version, a small random number is added to the current version to provide entropy in case multiple peers are writing simultaneously.

Conflicts resolve using ["arbitrary-writer-wins" (AWW)](https://braid.org/protocol/merge-types/aww): the version with the highest timestamp wins.



## Nodejs API

Import and configure braid-blob with:

```javascript
var braid_blob = require('braid-blob')

// Optional: set custom blob storage folder
braid_blob.db_folder = './braid-blobs'       // Default: ./braid-blobs
```

### Examples

#### Get a blob

```javascript
// Get a local blob:
var {body, version, content_type} = await braid_blob.get('foo')

// Get a remote blob:
var {body, version, content_type} = await braid_blob.get(new URL('https://foo.bar/baz'))

// Get a specific version of a remote blob:
var {body} = await braid_blob.get(
    new URL('https://foo.bar/baz'),
    {version: ['5zb2sjdstmk-1768093765048']}
)

// To subscribe to a remote blob, without storing updates locally:
await braid_blob.get(new URL('https://foo.bar/baz'), {
    subscribe: (update) => {
        console.log('Got update:', update.version, update.content_type)
        // update.body contains the new blob data
    }
})

// To mirror a remote blob to local storage (bidirectional sync):
var ac = new AbortController()
braid_blob.sync('local-key', new URL('https://foo.bar/baz'), {signal: ac.signal})
// Later, stop syncing:
ac.abort()
```

Note: `.get()` with `subscribe` receives updates but does not store them locally.  `.sync()` performs two subscriptions (local↔remote) plus auto-forwards updates in both directions.

#### Put a blob

```javascript
// Write to a local blob:
await braid_blob.put('foo', Buffer.from('hello'), {content_type: 'text/plain'})

// Write to a remote blob:
await braid_blob.put(
    new URL('https://foo.bar/baz'),
    Buffer.from('hello'),
    {content_type: 'text/plain'}
)
```

#### Delete a blob

```javascript
// Delete a local blob:
await braid_blob.delete('foo')

// Delete a remote blob:
await braid_blob.delete(new URL('https://foo.bar/baz'))
```

### API Reference

#### braid_blob.get(key, params)

Retrieves a blob from local storage or a remote URL.

Parameters:
- `key` - The local blob (if string) or remote URL (if [URL object](https://nodejs.org/api/url.html#class-url)) to read from
- `params` - Optional configuration object
  - `version` - Retrieve a specific version instead of the latest (e.g., `['abc-123']`)
  - `parents` - When subscribing, only receive updates newer than this version (e.g., `['abc-123']`)
  - `subscribe` - Callback `(update) => {}` called with each update; `update` has `{body, version, content_type}`
  - `head` - If `true`, returns only metadata (`{version, content_type}`) without the body—useful for checking if a blob exists or getting its current version
  - `content_type` - Expected content type (sent as Accept header for remote URLs)
  - `signal` - AbortSignal to cancel the request or stop a subscription

Returns: `{version, body, content_type}` object, or `null` if the blob doesn't exist.  When subscribing to a remote URL, returns the fetch response object; updates are delivered via the callback.

#### braid_blob.put(key, body, params)

Writes a blob to local storage or a remote URL.  Any other peers synchronizing with this blob (via `.serve()`, `.sync()`, or `.get(.., {subscribe: ..})`) will be updated.

Parameters:
- `key` - The local blob (if string) or remote URL (if [URL object](https://nodejs.org/api/url.html#class-url)) to write to
- `body` - The data to store (Buffer, ArrayBuffer, or Uint8Array)
- `params` - Optional configuration object
  - `version` - Specify a version ID for this write (e.g., `['my-version-1']`); if omitted, one is generated automatically
  - `content_type` - MIME type of the blob (e.g., `'image/png'`, `'application/json'`)
  - `signal` - AbortSignal to cancel the request

#### braid_blob.delete(key, params)

Deletes a blob from local storage or a remote URL.

Parameters:
- `key` - The local blob (if string) or remote URL (if [URL object](https://nodejs.org/api/url.html#class-url)) to delete
- `params` - Optional configuration object
  - `signal` - AbortSignal for cancellation

#### braid_blob.sync(key, url, params)

Synchronizes a remote URL bidirectionally with a local blob on disk.  This performs two subscriptions (one to the remote, one to the local blob) and auto-forwards updates in both directions.

Parameters:
- `key` - The local blob on disk (string)
- `url` - Remote URL (URL object)
- `params` - Optional configuration object
  - `signal` - AbortSignal for cancellation (use to stop sync)
  - `content_type` - Content type for requests

#### braid_blob.serve(req, res, params)

Serves blob requests over HTTP.  Synchronizes the client issuing the given request with its blob on disk.

Parameters:
- `req` - HTTP request object
- `res` - HTTP response object
- `params` - Optional configuration object
  - `key` - The blob on disk to sync with (default: the path from `req.url`)

## Browser Client API

A simple browser client is included for subscribing to blob updates.

```html
<script src="https://unpkg.com/braid-http@~1.3/braid-http-client.js"></script>
<script src="https://unpkg.com/braid-blob/client.js"></script>
<img id="image"/>
<script>
    braid_blob_client('http://localhost:8888/blob.png', {
        // Called whenever the blob is updated
        on_update: (blob, content_type, version) =>
            image.src = URL.createObjectURL(
                new Blob([blob], { type: content_type })),
        on_delete: () => image.src = '',
        on_error: (e) => console.error('Error:', e)
    })
</script>
```

### Subscribe to remote blob

```javascript
braid_blob_client(url, params)
```

Subscribes to a blob endpoint, and calls `params.on_update()` with each update.

Parameters:
- `url` - The blob endpoint URL
- `params` - Configuration object
  - `on_update(blob, content_type, version)` - Callback for updates
  - `on_delete` - Callback when blob is deleted
  - `on_error(e)` - Callback for errors
  - `signal` - AbortSignal for cancellation

## Live Image Polyfill

A polyfill that automatically syncs any `<img>` element with a `live` attribute. Images update in real-time whenever the blob changes on the server.

```html
<script src="https://unpkg.com/braid-http@~1.3/braid-http-client.js"></script>
<script src="https://unpkg.com/braid-blob/client.js"></script>
<script src="https://unpkg.com/braid-blob/img-live.js"></script>

<img live src="/blob.png">
```

That's it! The image will automatically stay synchronized with the server. When any client updates `/blob.png`, all `<img live src="/blob.png">` elements will update in real-time.

The polyfill:
- Observes the DOM for `<img live>` elements (added, removed, or attribute changes)
- Creates a `braid_blob_client` subscription for each live image
- Cleans up subscriptions when images are removed from the DOM

## Improving this Package

You can run the nodejs tests with:

```bash
npm install
node test/test.js
```

Or run the browser tests with:

```bash
node test/test.js -b
```

Then open http://localhost:8889/test.html
