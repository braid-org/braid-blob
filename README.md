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

## Interactive Demo

Run the demo web server with:

```shell
node server-demo.js
```

Now open up http://localhost:8888 in your browser, to see the client.  Open two windows.  You can drag and drop images between them, and they will always stay synchronized.

<video src="https://github.com/user-attachments/assets/0418a03f-31f5-4fc4-9ad4-e49fab6394c9" controls width="600"></video>

Todo: Demo what happens when you kill the server and make mutations.  They should all sync.  It might be even more impressive if the image is repeated 9 times on each screen, where each repeat is its own client, and you can drop onto any of them to change the other ones.  Then when you kill the serverk, you can change them individually.  When you bring it back, they'll all sync to the "latest" one.

## Network API

```
fill this in with GET, PUT, DELETE descriptions
- probably show some an example GET and PUT request/response?
- explain how to interpret the versions?
- reference the relevant braid specs
```

- `GET` - Retrieve a blob (with optional `Subscribe: true` header)
- `PUT` - Store/update a blob
- `DELETE` - Remove a blob


## Nodejs API

Import and configure braid-blob with:

```javascript
var braid_blob = require('braid-blob')

braid_blob.db_folder = './braid-blobs'  // Optional: set custom blob storage folder
```

### Serve blobs to HTTP Requests (GET, PUT, and DELETE)

Your app becomes a blob server with:

```javascript
braid_blob.serve(req, res, options)
```

This will synchronize the client issuing the given request and response with the blob on disk.

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

Synchronizes a remote URL to a blob on disk.

Parameters:
- `key` - Local storage key (string)
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

Parameters:
- `key` - Local storage key (if string) or remote URL (if [URL object](https://nodejs.org/api/url.html#class-url))
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

Stores a blob to local storage or a remote URL.

Parameters:
- `key` - Local storage key (if string) or remote URL (if [URL object](https://nodejs.org/api/url.html#class-url))
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
- `key` - Local storage key (if string) or remote URL (if [URL object](https://nodejs.org/api/url.html#class-url))
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

Subscribes to a blob endpoint and receives updates.

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
