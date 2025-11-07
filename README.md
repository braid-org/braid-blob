# braid-blob

A simple, self-contained library for synchronizing binary blobs (files, images, etc.) over HTTP using [Braid-HTTP](https://braid.org). It provides real-time synchronization with last-write-wins (LWW) conflict resolution and persistent storage.

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

// Set custom storage location (default: './braid-blob-db')
braid_blob.db_folder = './custom_files_folder'

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

## Testing

### to run unit tests:
first run the test server:

    npm install
    node test/server.js

then open http://localhost:8889/test.html, and the boxes should turn green as the tests pass.
