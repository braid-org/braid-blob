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

<video src="https://github.com/user-attachments/assets/0efc9fdc-71c8-4437-ac54-5b6dca30ac66" controls width="600"></video>

## Network API

Braid-blob speaks [Braid-HTTP](https://github.com/braid-org/braid-spec), an extension to HTTP for synchronization.

### Special Braid-HTTP Headers

| Header | Description |
|--------|-------------|
| `Version` | Unique identifier for this version of the blob (e.g., `"alice-42"`) |
| `Parents` | The previous version |
| `Merge-Type` | How conflicts resolve consistently (*e.g.* `aww` for arbitrary-writer-wins) |
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
Version: "alice-1"
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
HTTP/1.1 209 Subscription
Subscribe: true
Current-Version: "alice-1"

HTTP 200 OK
Version: "alice-1"
Content-Type: image/png
Merge-Type: aww
Content-Length: 12345

<binary data>

HTTP 200 OK
Version: "bob-2"
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
Version: "carol-3"
Content-Type: image/png
Merge-Type: aww
Content-Length: 34567

<binary data>
```

Response:

```http
HTTP/1.1 200 OK
Version: "carol-3"
```

The PUT always succeeds, but if the sent version is eclipsed by the server's current version, the returned `Version` will be the server's version (not the one you sent).

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

Versions look like `"alice-42"` where:
- `alice` is a peer ID (identifies who made the change)
- `42` is a sequence number (generally milliseconds past the epoch, or one plus the current number if it is past the current time)

Conflicts resolve using ["arbitrary-writer-wins" (AWW)](https://braid.org/protocol/merge-types/aww): the version with the highest sequence number wins. If sequences match, the peer ID string is compared lexicographically.



## Nodejs API

Import and configure braid-blob with:

```javascript
var braid_blob = require('braid-blob')

// Optional: set custom blob storage folder
braid_blob.db_folder = './braid-blobs'       // Default: ./braid-blobs
```

### Serve blobs to HTTP Requests (GET, PUT, and DELETE)

Your app becomes a blob server with:

```javascript
braid_blob.serve(req, res, options)
```

This will synchronize the client issuing the given request and response with its blob on disk.

Parameters:
- `req` - HTTP request object
- `res` - HTTP response object
- `options` - Optional configuration object
  - `key` - The blob on disk to sync with (default: `req.url`)

### Sync a remotely served blob to disk

Your app becomes a blob client with:

```javascript
braid_blob.sync(key, url, options)
```

Synchronizes a remote URL to its blob on disk.

Parameters:
- `key` - The blob on disk (string)
- `url` - Remote URL (URL object)
- `options` - Optional configuration object
  - `signal` - AbortSignal for cancellation (use to stop sync)
  - `content_type` - Content type for requests

### Read, Write or Delete a blob

#### Read a local or remote blob

```javascript
braid_blob.get(key, options)
```

Retrieves a blob from local storage or a remote URL.

Examples:
```javascript
// Get the current contents of a local blob:
braid_blob.get('foo').body

// Get the contents of a remote blob:
braid_blob.get(new URL('https://foo.bar/baz')).body

// Get an old version of a remote blob:
braid_blob.get(
   new URL('https://foo.bar/baz'),
   {version: ["5zb2sjdstmk-1768093765048"]}
).body
```

Parameters:
- `key` - The local blob (if string) or remote URL (if [URL object](https://nodejs.org/api/url.html#class-url)) to read from
- `options` - Optional configuration object
  - `version` - Version ID to check existence (use with `head: true`)
  - `parent` - Version ID; when subscribing, only receive updates newer than this
  - `subscribe` - Callback function for real-time updates
  - `head` - If true, returns only metadata (version, content_type) without body
  - `content_type` - Content type for the request
  - `signal` - AbortSignal for cancellation

Returns: `{version, body, content_type}` object, or `null` if not found.

#### Write a local or remote blob

```javascript
braid_blob.put(key, body, options)
```

Writes a blob to local storage or a remote URL.  Any other peers synchronizing with this blob (via `.serve()`, `.sync()`, or `.get(.., {subscribe: ..}`) will be updated.

Parameters:
- `key` - The local blob (if string) or remote URL (if [URL object](https://nodejs.org/api/url.html#class-url)) to write to
- `body` - Buffer or data to store
- `options` - Optional configuration object
  - `version` - Version identifier
  - `content_type` - Content type of the blob
  - `signal` - AbortSignal for cancellation

#### Delete a local or remote blob

```javascript
braid_blob.delete(key, options)
```

Deletes a blob from local storage or a remote URL.

Parameters:
- `key` - The local blob (if string) or remote URL (if [URL object](https://nodejs.org/api/url.html#class-url)) to delete
- `options` - Optional configuration object
  - `signal` - AbortSignal for cancellation

## Browser Client API

A simple browser client is included for subscribing to blob updates.

```html
<script src="https://unpkg.com/braid-http@~1.3/braid-http-client.js"></script>
<script src="http://localhost:8888/client.js"></script>
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
braid_blob_client(url, options)
```

Subscribes to a blob endpoint, and calls `options.on_update()` with each update.

Parameters:
- `url` - The blob endpoint URL
- `options` - Configuration object
  - `on_update(blob, content_type, version)` - Callback for updates
  - `on_delete` - Callback when blob is deleted
  - `on_error(e)` - Callback for errors
  - `signal` - AbortSignal for cancellation

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
