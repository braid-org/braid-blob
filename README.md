# braid-blob

A simple, self-contained library for synchronizing binary blobs (files, images, etc.) over HTTP using [Braid-HTTP](https://braid.org). It provides real-time synchronization with arbitrary-writer-wins (AWW) conflict resolution and persistent storage.

## Quick Start

### Installation

```bash
npm install braid-blob
```

### Basic Server

```javascript
var braid_blob = require('braid-blob')

require('http').createServer((req, res) => {
    braid_blob.serve(req, res)
}).listen(8888)
```

That's it! You now have a blob synchronization server. Upload an image:

```bash
curl -X PUT -H "Content-Type: image/png" -T blob.png http://localhost:8888/blob.png
```

Then view it at http://localhost:8888/blob.png

### Demo

Run the demo server:

```bash
node server-demo.js
```

Then open http://localhost:8888 in your browser. You can drag and drop images to upload them, and open multiple browser windows to see real-time sync in action.

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
  - `content_type` / `accept` - Content type for requests
  - `on_pre_connect` - Async callback before connection attempt
  - `on_disconnect` - Callback when connection drops
  - `on_unauthorized` - Callback on 401/403 responses
  - `on_res` - Callback receiving the response object

### `braid_blob.get(key, options)`

Retrieves a blob from local storage or a remote URL.

**Parameters:**
- `key` - Local storage key (string) or remote URL (URL object)
- `options` - Optional configuration object
  - `version` - Request a specific version
  - `parents` - Version parents for subscription fork-point
  - `subscribe` - Callback function for real-time updates
  - `head` - If true, returns only metadata (version, content_type) without body
  - `content_type` / `accept` - Content type for the request
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
<script src="/client.js"></script>
<script>
    braid_blob_client('http://localhost:8888/blob.png', {
        on_update: (blob, content_type, version) => {
            // Called whenever the blob is updated
            var url = URL.createObjectURL(new Blob([blob], { type: content_type }))
            document.getElementById('image').src = url
        },
        on_delete: () => console.log('Blob was deleted'),
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
  - `on_error` - Callback for errors
  - `on_res` - Callback receiving the response object

**Returns:** `{ stop }` - Call `stop()` to unsubscribe.

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
