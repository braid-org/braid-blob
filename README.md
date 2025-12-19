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

That's it! You now have a blob synchronization server.

### Usage Examples

First let's upload a file:
```bash
curl -X PUT -H "Content-Type: image/png" -T blob.png http://localhost:8888/image.png
```

View image in browser at http://localhost:8888/image.png

To see updates, let's do a textual example for easy viewing:

```
curl -X PUT -H "Content-Type: text/plain" -d "hello" http://localhost:8888/text
```

Next, subscribe for updates:
```
curl -H "Subscribe: true" http://localhost:8888/text
```

Now, in another terminal, write over the file:
```bash
curl -X PUT -H "Content-Type: text/plain" -d "world" http://localhost:8888/text
```

Should see activity in the first terminal showing the update.

```
# Delete a file
curl -X DELETE http://localhost:8888/text
```

## API

### Configuration

```javascript
var braid_blob = require('braid-blob')

// Set custom blob storage location (default: './braid-blob-db')
// This uses url-file-db for efficient URL-to-file mapping
braid_blob.db_folder = './custom_files_folder'

// Set custom metadata storage location (default: './braid-blob-meta')
// Stores version metadata and peer information
braid_blob.meta_folder = './custom_meta_folder'

// Set custom peer ID (default: auto-generated and persisted)
braid_blob.peer = 'my-server-id'
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
  - `content_type` / `accept` - Content type of the blob
  - `signal` - AbortSignal for cancellation

### `braid_blob.sync(a, b, options)`

Bidirectionally synchronizes blobs between two endpoints (local keys or URLs).

**Parameters:**
- `a` - First endpoint (local key or URL)
- `b` - Second endpoint (local key or URL)
- `options` - Optional configuration object
  - `signal` - AbortSignal for cancellation (use to stop sync)
  - `content_type` / `accept` - Content type for requests
  - `on_pre_connect` - Async callback before connection attempt
  - `on_disconnect` - Callback when connection drops
  - `on_unauthorized` - Callback on 401/403 responses
  - `on_res` - Callback receiving the response object

## Testing

### to run unit tests:
first run the test server:

    npm install
    node test/server.js

then open http://localhost:8889/test.html, and the boxes should turn green as the tests pass.
