# AI-README.md

Machine-optimized documentation for braid-blob library.

## DEVELOPMENT_BEST_PRACTICES

```
REPOSITORY: braid-org/braid-blob
MAIN_BRANCH: master
NPM_PACKAGE: braid-blob

VERSION_BUMP_WORKFLOW:
  1. Make code changes
  2. Update package.json version (increment patch: 0.0.X -> 0.0.X+1)
  3. Git commit with formatted message (see below)
  4. Git push to origin/master
  5. npm publish

COMMIT_MESSAGE_FORMAT:
  Pattern: "{version} - {brief description of changes}"
  Style: concise, lowercase, describes what was added/fixed/changed
  Examples:
    - "0.0.20 - adds test.js test runner"
    - "0.0.19 - adds URL support for get/put operations and sync function for bidirectional synchronization"
    - "0.0.18 - fixes meta filename case collision issue on case-insensitive filesystems, updates to url-file-db 0.0.8"
    - "0.0.17 - refactors to use url-file-db, separates meta and blob storage, adds new test infrastructure"
  Footer:
    🤖 Generated with [Claude Code](https://claude.com/claude-code)

    Co-Authored-By: Claude <noreply@anthropic.com>

GIT_WORKFLOW:
  - Always stage all changes: git add -A
  - Commit message uses heredoc for proper formatting
  - Push immediately after commit
  - No feature branches (direct to master)
  - Force-add ignored files if explicitly requested: git add -f

NPM_PUBLISH_WORKFLOW:
  - Run after git push completes
  - Command: npm publish
  - No additional flags needed
  - Warnings about repository field normalization are expected and safe

TESTING_BEFORE_PUBLISH:
  - Run: npm test (node test/test.js)
  - Or: npm run test:browser (browser-based tests)
  - Tests use local server on port 8889
  - All tests must pass before publishing

DEPENDENCY_UPDATES:
  - Update package.json dependency version
  - Mention dependency update in commit message
  - Format: "updates to {package}@{version}"
  - Example: "0.0.18 - ... updates to url-file-db 0.0.8"

RESOLVED_ISSUES:
  - url-file-db < 0.0.13: Bug where reading non-existent files returned "index" file contents
    - Fixed in url-file-db 0.0.13+ (properly returns null for non-existent files)
    - Caused "test sync local to remote" to fail with unexpected "shared content"
    - url-file-db 0.0.15+ also relaxed path requirements (no longer requires leading "/")
```

## MODULE_STRUCTURE

```
EXPORT: create_braid_blob() -> braid_blob_instance
MODULE_TYPE: CommonJS
MAIN_ENTRY: index.js
DEPENDENCIES: [braid-http, url-file-db, fs, path]
```

## DATA_MODEL

```
braid_blob_instance = {
  // Configuration
  db_folder: string = './braid-blob-db'           // blob storage location
  meta_folder: string = './braid-blob-meta'       // metadata storage location
  peer: string | null                             // peer identifier (auto-generated if null)

  // Runtime state
  cache: object                                   // internal cache
  key_to_subs: Map<key, Map<peer, subscription>> // subscription tracking
  db: url_file_db_instance                        // blob storage backend
  meta_db: url_file_db_instance                   // metadata storage backend

  // Methods
  init: async () -> void
  put: async (key, body, options) -> version_string
  get: async (key, options) -> result_object | null
  serve: async (req, res, options) -> void
  sync: async (a, b, options) -> void
}
```

## VERSION_SYSTEM

```
VERSION_FORMAT: "{peer_id}-{timestamp}"
EXAMPLE: "abc123xyz-1699564820000"
COMPARISON_RULES:
  1. Compare numeric length of timestamp
  2. If equal, lexicographic compare timestamp
  3. If equal, lexicographic compare full version string
MERGE_TYPE: last-write-wins (lww)
```

## METADATA_SCHEMA

```json
{
  "event": "peer_id-timestamp",
  "content_type": "mime/type"
}
```

## API_METHODS

### put(key, body, options)

```
INPUT:
  key: string | URL
    - string: local key for storage
    - URL: remote endpoint for HTTP PUT
  body: Buffer | string
  options: {
    version?: [string]           // explicit version (default: auto-generated)
    content_type?: string         // MIME type
    peer?: string                 // peer identifier
    skip_write?: boolean          // skip disk write (for external changes)
    signal?: AbortSignal          // for URL mode
    headers?: object              // for URL mode
  }

OUTPUT: version_string

SIDE_EFFECTS:
  - Writes blob to db_folder via url-file-db
  - Writes metadata to meta_folder/db
  - Notifies active subscriptions (except originating peer)
  - If key instanceof URL: makes remote HTTP PUT via braid_fetch

VERSION_LOGIC:
  - If options.version provided: use options.version[0]
  - Else: generate "{peer}-{max(Date.now(), last_version_seq+1)}"
  - Only write if new version > existing version (lww)
```

### get(key, options)

```
INPUT:
  key: string | URL
    - string: local key to retrieve
    - URL: remote endpoint for HTTP GET
  options: {
    subscribe?: callback(update)  // enable subscription mode
    header_cb?: callback(result)  // called before body read
    before_send_cb?: callback(result) // called before subscription starts
    head?: boolean                // HEAD mode (no body)
    parents?: [version]           // fork-point for subscriptions
    version?: [version]           // request specific version
    peer?: string                 // peer identifier
    signal?: AbortSignal          // for URL mode
    dont_retry?: boolean          // for URL mode subscriptions
  }

OUTPUT:
  - If subscribe: result_object with unsubscribe callback
  - If URL + subscribe: Response object or Promise rejection
  - If URL + !subscribe: ArrayBuffer
  - If local + !subscribe: {body: Buffer, version: [string], content_type: string}
  - If not found: null

result_object: {
  version: [string]
  content_type?: string
  body?: Buffer               // only if !subscribe
  unsubscribe?: function      // only if subscribe
  sent?: boolean              // true if immediate update sent
}

SUBSCRIPTION_BEHAVIOR:
  - Immediate update sent if: no parents OR local_version > parents
  - Future updates sent when put() called
  - Subscription callback receives: {body: Buffer, version: [string], content_type: string}

ERROR_HANDLING:
  - Throws "unkown version: {version}" if requested version > local version
  - Returns 309 status code via serve() when version unknown
```

### serve(req, res, options)

```
INPUT:
  req: http.IncomingMessage (braidified)
  res: http.ServerResponse (braidified)
  options: {
    key?: string  // override URL-based key extraction
  }

HTTP_METHOD_MAPPING:
  GET:
    - Calls get() with req.subscribe, req.parents, req.version, req.peer
    - Sets headers: Editable, Accept-Subscribe, Merge-Type, Version/Current-Version
    - Returns 404 if not found
    - Returns 406 if Content-Type not in Accept header
    - Returns 309 if requested version > server version

  HEAD:
    - Same as GET but no body

  PUT:
    - Calls put() with body, req.version, req.headers['content-type'], req.peer
    - Returns Version header with new version

  DELETE:
    - Deletes from db and meta_db
    - Returns 204 No Content

  OPTIONS:
    - Returns empty response

CONCURRENCY:
  - All operations on same key serialized via within_fiber()
  - Different keys process in parallel
```

### sync(a, b, options)

```
INPUT:
  a: string | URL  // local key or remote endpoint
  b: string | URL  // local key or remote endpoint
  options: {
    // options.my_unsync set by function, call to stop sync
  }

OUTPUT: void (async, runs indefinitely)

BEHAVIOR_MATRIX:
  a=local, b=local:
    - Bidirectional subscription
    - Updates to a -> put(b), updates to b -> put(a)

  a=local, b=URL (or a=URL, b=local - swapped internally):
    - Fork-point detection via HEAD request with local version
    - If server has local version: subscribe with parents=local_version
    - If server lacks local version: subscribe without parents (full sync)
    - Local changes pushed to remote via PUT
    - Remote changes pulled to local via subscription
    - Auto-reconnect on error with 1 second delay
    - Respects options.my_unsync() for clean shutdown

  a=URL, b=URL:
    - Bidirectional subscription
    - Updates from a -> put(b), updates from b -> put(a)

ERROR_RECOVERY:
  - Remote sync: catches errors, disconnects, retries after 1s
  - Checks 'closed' flag before retry
  - AbortController cleanup on disconnect
```

## UTILITY_FUNCTIONS

```
compare_events(a, b) -> -1 | 0 | 1
  Compares version strings by timestamp length, then timestamp value, then full string

get_event_seq(event) -> string
  Extracts timestamp portion after last '-'

ascii_ify(string) -> string
  Escapes non-ASCII characters as \uXXXX for HTTP headers

version_to_header(version_array) -> string
  Converts ["v1", "v2"] -> '"v1", "v2"' for HTTP headers

within_fiber(id, func) -> Promise
  Serializes async operations per ID to prevent race conditions

slurp(req) -> Promise<Buffer>
  Reads entire HTTP request body

isAcceptable(contentType, acceptHeader) -> boolean
  Checks if contentType matches Accept header patterns
```

## STORAGE_LAYOUT

```
db_folder/
  {url_file_db structure}
  - Blob data stored via url-file-db
  - Key mapping: URL-safe encoding of keys

meta_folder/
  peer.txt          # Peer ID (auto-generated if missing)
  db/               # url-file-db for metadata
    {encoded_key}.txt  # JSON: {event: version, content_type: mime}
```

## PROTOCOL_DETAILS

```
HTTP_HEADERS:
  Request:
    Subscribe: true                  # enable subscription mode
    Version: "v1", "v2"             # specific version (for GET)
    Parents: "v1", "v2"             # fork-point for subscriptions
    Content-Type: mime/type          # for PUT
    Accept: mime/type                # for GET (406 if mismatch)

  Response:
    Version: "v1"                    # for PUT response
    Current-Version: "v1"            # for subscribed GET
    Editable: true
    Accept-Subscribe: true
    Merge-Type: lww
    Content-Type: mime/type

STATUS_CODES:
  200 OK               # successful GET/PUT
  204 No Content       # successful DELETE
  309 Custom           # "Version Unknown Here" - requested version not found
  404 Not Found        # resource doesn't exist
  406 Not Acceptable   # Content-Type not in Accept header

BRAID_UPDATE_FORMAT:
  Version: "v1"\r\n
  Merge-Type: lww\r\n
  Content-Length: N\r\n
  \r\n
  {body}
```

## KEY_BEHAVIORS

```
INITIALIZATION:
  - init() called lazily by put/get/serve
  - init() runs once (subsequent calls return same promise)
  - Creates db and meta_db url-file-db instances
  - Loads or generates peer ID

SUBSCRIPTION_MANAGEMENT:
  - key_to_subs: Map<string, Map<string, {sendUpdate}>>
  - Outer key: resource key
  - Inner key: peer identifier
  - Prevents echo: put() doesn't notify originating peer
  - Serialized updates: subscribe_chain ensures sequential callback execution

FILE_WATCHING:
  - url-file-db monitors db_folder for external changes
  - External changes trigger put() with skip_write: true
  - Subscriptions notified of external changes

CONCURRENCY_CONTROL:
  - within_fiber(key, fn) serializes operations per key
  - Uses promise chain stored in within_fiber.chains[key]
  - Prevents concurrent modification of same resource
  - Automatic cleanup when chain completes
```

## INTEGRATION_PATTERNS

```
BASIC_SERVER:
  require('http').createServer((req, res) => {
    braid_blob.serve(req, res)
  }).listen(PORT)

CUSTOM_KEY_MAPPING:
  braid_blob.serve(req, res, {
    key: extract_key_from_url(req.url)
  })

REMOTE_REPLICATION:
  await braid_blob.sync('local-key', new URL('http://remote/path'))

BIDIRECTIONAL_SYNC:
  await braid_blob.sync(
    new URL('http://server1/key'),
    new URL('http://server2/key')
  )

PROGRAMMATIC_ACCESS:
  // Local storage
  await braid_blob.put('key', Buffer.from('data'), {version: ['v1']})
  const result = await braid_blob.get('key')

  // Remote storage
  await braid_blob.put(new URL('http://remote/key'), Buffer.from('data'))
  const data = await braid_blob.get(new URL('http://remote/key'))

SUBSCRIPTION_EXAMPLE:
  await braid_blob.get('key', {
    subscribe: async (update) => {
      console.log('Version:', update.version)
      console.log('Body:', update.body.toString())
    }
  })
```

## DEPENDENCIES_DETAIL

```
braid-http:
  - http_server (braidify): Adds Braid protocol support to Node.js HTTP
  - fetch (braid_fetch): Braid-aware fetch implementation
  - Handles: Subscribe headers, Version headers, streaming updates

url-file-db (^0.0.15):
  - Bidirectional URL ↔ filesystem mapping
  - Collision-resistant encoding (case-insensitive filesystem safe)
  - File watching for external changes
  - Separate instances for blobs (db) and metadata (meta_db)
  - API change in 0.0.15: use get_canonical_path() instead of url_path_to_canonical_path()
  - Fixed in 0.0.13+: properly returns null for non-existent files (not "index" content)
```

## ERROR_CONDITIONS

```
"unkown version: {version}"
  - GET with version/parents newer than local version
  - Results in 309 status via serve()

AbortError:
  - sync() handles when AbortController triggered
  - Ignored silently in local→remote sync

Connection errors (sync):
  - Caught and trigger reconnect after 1s delay
  - Stops retry if closed flag set

File not found:
  - get() returns null for non-existent keys
  - serve() returns 404

Content-Type mismatch:
  - serve() returns 406 if Content-Type not in Accept header
```

## TESTING_INFRASTRUCTURE

```
TEST_RUNNER: test/test.js
  - Runs in Node.js or browser
  - Uses /eval endpoint for isolated test execution
  - Browser mode: Opens puppeteer, loads test.html

TEST_SUITE: test/tests.js
  - 40+ test cases covering:
    - Basic put/get operations
    - Subscriptions and updates
    - Version conflict resolution
    - Remote operations (URL mode)
    - Sync functionality
    - Error handling
    - Edge cases (version unknown, fork-points)
```
