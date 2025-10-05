
var {http_server: braidify, free_cors} = require('braid-http'),
    fs = require('fs'),
    path = require('path'),
    port = 8888

var braid_blob = {
    storage_base: './braid-blob-files',
    cache: {}
}

// Helper function to normalize URL and create host-specific path
function get_storage_path(req) {
    // Get host from request headers, default to localhost if not present
    const host = req.headers.host || `localhost:${port}`;
    // Remove protocol and normalize, similar to index.js
    let normalized_host = host.replace(/^https?:\/\//, '');
    // Remove any double slashes that might occur
    normalized_host = normalized_host.replace(/\/+/g, '/');
    // Ensure path doesn't start with a slash (since we'll join with storage_base)
    if (normalized_host.startsWith('/')) normalized_host = normalized_host.substring(1);
    // Combine host and URL for storage path
    const combined_path = `${normalized_host}${req.url}`;
    // Remove any double slashes that might result from concatenation
    return combined_path.replace(/\/+/g, '/');
}

var subscriptions = {};

// Create a hash key for subscriptions based on peer and URL
var hash = (req) => JSON.stringify([req.headers.peer, req.url]);

braid_blob.serve = async (req, res, options = {}) => {
    if (!options.filename) options.filename = path.join(braid_blob.storage_base, get_storage_path(req))

    braidify(req, res)

    // Enable CORS
    free_cors(res);

    // Handle OPTIONS request
    if (req.method === 'OPTIONS') return res.end();

    const filename = options.filename

    if (req.method === 'GET') {
        // Handle GET request for binary files
        if (req.subscribe) {
            // Start a subscription for future updates. Also ensure a file exists with an early timestamp.
            res.startSubscription({ onClose: () => delete subscriptions[hash(req)] });
            subscriptions[hash(req)] = res;
            try {
                const dir = path.dirname(filename);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                if (!fs.existsSync(filename)) {
                    // Create an empty file and set mtime to early timestamp (e.g., epoch + 1ms)
                    fs.writeFileSync(filename, Buffer.alloc(0));
                    const early = new Date(1);
                    fs.utimesSync(filename, early, early);
                }
            } catch (e) {
                console.log(`Error ensuring file on subscribe ${filename}: ${e.message}`);
            }
        } else {
            res.statusCode = 200;
        }

        // Read binary file and send it in response
        try {
            if (fs.existsSync(filename)) {
                const stat = fs.statSync(filename);
                // console.log(stat.mtimeMs)
                const fileData = fs.readFileSync(filename);
                // Restore original timestamps to prevent mtime changes from file system read operations
                fs.utimesSync(filename, stat.atime, stat.mtime);
                res.setHeader('Last-Modified-Ms', String(Math.round(Number(stat.mtimeMs))));

                // Check if client has a local file timestamp that's newer or equal
                const localTimestampHeader = req.headers['x-local-file-timestamp'];
                const serverTimestamp = Math.round(Number(stat.mtimeMs));
                const localTimestamp = localTimestampHeader ? Math.round(Number(localTimestampHeader)) : undefined;

                if (localTimestamp !== undefined && serverTimestamp <= localTimestamp) {
                    console.log(`Skipping update for ${req.url}: server timestamp ${serverTimestamp} <= local timestamp ${localTimestamp}`);
                    // Don't send the file data, just send headers and empty response
                    res.sendUpdate({ body: Buffer.alloc(0), version: [String(serverTimestamp)] });
                } else {
                    // Send the file data as normal (when no local timestamp header or server is newer)
                    res.sendUpdate({ body: fileData, version: [String(Math.round(Number(stat.mtimeMs)))] });
                }
            } else {
                // File doesn't exist on server, return empty response
                // It cannot reach this point if request is subscribed to!
                res.statusCode = 404;
                res.end("File not found");
            }
        } catch (err) {
            console.log(`Error reading binary file ${filename}: ${err.message}`);
            res.statusCode = 500;
            res.end("Internal server error");
        }

        if (!req.subscribe) res.end();
    } else if (req.method === 'PUT') {
        // Handle PUT request to update binary files
        let body = [];
        req.on('data', chunk => body.push(chunk));
        req.on('end', () => {
            body = Buffer.concat(body);

            try {
                // Ensure directory exists
                const dir = path.dirname(filename);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
                
                // Write the file
                fs.writeFileSync(filename, body);

                // Get timestamp from header or use current time
                const timestamp = req.headers['x-timestamp'] ? Math.round(Number(req.headers['x-timestamp']) ): Number(Date.now());
                // console.log(timestamp)
                const mtimeSeconds = timestamp / 1000;
                fs.utimesSync(filename, mtimeSeconds, mtimeSeconds);
                // console.log(fs.statSync(filename).mtimeMs);
                // console.log(`Binary file written: ${filename}`);

                const stat = fs.statSync(filename);

                // Notify all subscriptions of the update (except the peer which made the PUT request itself)
                for (var k in subscriptions) {
                    var [peer, url] = JSON.parse(k);
                    // console.log(req.headers.peer)
                    if (peer !== req.headers.peer && url === req.url) {
                        subscriptions[k].sendUpdate({ body, version: [String(Math.round(Number(stat.mtimeMs)))] });
                    }
                }

                res.setHeader('Last-Modified', new Date(Math.round(Number(stat.mtimeMs))).toUTCString());
                res.setHeader('Last-Modified-Ms', String(Math.round(Number(stat.mtimeMs))));
                res.statusCode = 200;
                res.end();
            } catch (err) {
                console.log(`Error writing binary file ${filename}: ${err.message}`);
                res.statusCode = 500;
                res.end("Internal server error");
            }
        });
    }
}

module.exports = braid_blob
