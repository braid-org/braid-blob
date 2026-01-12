
var port = process.argv[2] || 8888
var braid_blob = require(`${__dirname}/index.js`)

// TODO: set a custom storage base
// (the default is ./braid-blobs)
//
// braid_blob.db_folder = './custom_files_folder'

braid_blob.init()

var server = require("http").createServer(async (req, res) => {
    console.log(`${req.method} ${req.url}`)

    var url = req.url.split('?')[0]

    if (url === '/client.js') {
        res.writeHead(200, {
            "Content-Type": "text/javascript",
            "Cache-Control": "no-cache"
        })
        require("fs").createReadStream(`${__dirname}/client.js`).pipe(res)
        return
    }

    if (url === '/img-live.js') {
        res.writeHead(200, {
            "Content-Type": "text/javascript",
            "Cache-Control": "no-cache"
        })
        require("fs").createReadStream(`${__dirname}/img-live.js`).pipe(res)
        return
    }

    if (url === '/' || url === '/client-demo.html') {
        res.writeHead(200, {
            "Content-Type": "text/html",
            "Cache-Control": "no-cache"
        })
        require("fs").createReadStream(`${__dirname}/client-demo.html`).pipe(res)
        return
    }

    if (url === '/img-live-demo.html') {
        res.writeHead(200, {
            "Content-Type": "text/html",
            "Cache-Control": "no-cache"
        })
        require("fs").createReadStream(`${__dirname}/img-live-demo.html`).pipe(res)
        return
    }

    braid_blob.serve(req, res)
})

server.listen(port, () => {
    console.log(`server started on http://localhost:${port}`)
})

// curl -X PUT -H "Content-Type: image/png" --data-binary @blob.png http://localhost:8888/blob.png
// curl http://localhost:8888/blob.png --output new-blob.png
