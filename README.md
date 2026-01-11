# braid-blob

A simple, self-contained library for synchronizing binary blobs (files, images, etc.) over HTTP using [Braid-HTTP](https://braid.org). It provides real-time synchronization with arbitrary-writer-wins (AWW) conflict resolution and persistent storage.

## Quick Start

Install this library in your Javascript project:

```bash
npm install braid-blob
```

And now use it to server HTTP requests with:

```javascript
require('http').createServer((req, res) => {
    require('braid-blob').serve(req, res)
}).listen(8888)
```

That's it! You are now serving synchronized binary blobs at http://localhost:8888/*.

Upload an image to it:

```bash
curl -X PUT -H "Content-Type: image/png" -T blob.png http://localhost:8888/blob.png
```

You can view it at http://localhost:8888/blob.png

### Browser Client Demo

Clone the repo and run the demo server:

```bash
git clone https://github.com/braid-org/braid-blob.git
cd braid-blob
npm install
node server-demo.js
```

Then open http://localhost:8888 in your browser to see the browser client demo. You can drag and drop images to upload them, and open multiple browser windows to see real-time sync in action.

<video src="https://github.com/user-attachments/assets/0418a03f-31f5-4fc4-9ad4-e49fab6394c9" controls width="600"></video>

## API

### Configuration

```javascript
var braid_blob = require('braid-blob')

// Set custom storage location (default: './braid-blobs')
braid_blob.db_folder = './my-blobs'
```

### `braid_blob.serve(req, res, options)`

Handles HTTP requests for blob storage and synchronization.

**Parameters:**
- `req` - HTTP request object
- `res` - HTTP response object
- `options` - Optional configuration object
  - `key` - Override the resource key (default: URL path)

**Supported HTTP Methods:**
- `GET` - Retrieve a blob (with optional `Subscribe: true` header)
- `PUT` - Store/update a blob
- `DELETE` - Remove a blob

### `braid_blob.sync(key, url, options)`

Bidirectionally synchronizes a blob between local storage and a remote URL.

**Parameters:**
- `key` - Local storage key (string)
- `url` - Remote URL (URL object)
- `options` - Optional configuration object
  - `signal` - AbortSignal for cancellation (use to stop sync)
  - `content_type` - Content type for requests

### `braid_blob.get(key, options)`

Retrieves a blob from local storage or a remote URL.

**Parameters:**
- `key` - Local storage key (string) or remote URL (URL object)
- `options` - Optional configuration object
  - `version` - Version ID to check existence (use with `head: true`)
  - `parent` - Version ID; when subscribing, only receive updates newer than this
  - `subscribe` - Callback function for real-time updates
  - `head` - If true, returns only metadata (version, content_type) without body
  - `content_type` - Content type for the request
  - `signal` - AbortSignal for cancellation

**Returns:** `{version, body, content_type}` object, or `null` if not found.

### `braid_blob.put(key, body, options)`

Stores a blob to local storage or a remote URL.

**Parameters:**
- `key` - Local storage key (string) or remote URL (URL object)
- `body` - Buffer or data to store
- `options` - Optional configuration object
  - `version` - Version identifier
  - `content_type` - Content type of the blob
  - `signal` - AbortSignal for cancellation

### `braid_blob.delete(key, options)`

Deletes a blob from local storage or a remote URL.

**Parameters:**
- `key` - Local storage key (string) or remote URL (URL object)
- `options` - Optional configuration object
  - `signal` - AbortSignal for cancellation

## Browser Client

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

### `braid_blob_client(url, options)`

Subscribes to a blob endpoint and receives updates.

**Parameters:**
- `url` - The blob endpoint URL
- `options` - Configuration object
  - `on_update(blob, content_type, version)` - Callback for updates
  - `on_delete` - Callback when blob is deleted
  - `on_error(e)` - Callback for errors
  - `signal` - AbortSignal for cancellation

## Testing

```bash
npm install
node test/test.js
```

Or run tests in the browser:

```bash
node test/test.js -b
```

Then open http://localhost:8889/test.html
