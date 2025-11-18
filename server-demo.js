
var port = process.argv[2] || 8888
var braid_blob = require(`${__dirname}/index.js`)

// TODO: set a custom storage base
// (the default is ./braid-blob-files)
//
// braid_blob.db_folder = './custom_files_folder'
// braid_blob.meta_folder = './custom_meta_folder'

braid_blob.init()

var server = require("http").createServer(async (req, res) => {
    console.log(`${req.method} ${req.url}`)

    braid_blob.serve(req, res)
})

server.listen(port, () => {
    console.log(`server started on port ${port}`)
    console.log(`files stored in: ${braid_blob.db_folder}`)
})

// curl -X PUT -H "Content-Type: image/png" --data-binary @blob.png http://localhost:8888/blob.png
// curl http://localhost:8888/blob.png --output new-blob.png
