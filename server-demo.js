
var port = process.argv[2] || 8888
var braid_blob = require(`${__dirname}/index.js`)

// TODO: set a custom storage base
// (the default is ./braid-blob-files)
//
// braid_blob.storage_base = './custom_files_folder'

var server = require("http").createServer(async (req, res) => {
    console.log(`${req.method} ${req.url}`)

    braid_blob.serve(req, res)
})

server.listen(port, () => {
    console.log(`server started on port ${port}`)
    console.log(`files stored in: ${braid_blob.storage_base}`)
})

// curl -X PUT --data-binary @image.png http://localhost:8888/image.png
// curl http://localhost:8888/image.png --output downloaded_image.png
