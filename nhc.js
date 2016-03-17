// nhc.js
//
// nginx health check daemon

///////////////////////////////////////////////////////////////// DEPS
var ini = require('ini')
var nx = require('nginx-conf').NginxConfFile
var fs = require('fs')
var sys = require('sys')
var path = require('path')
var ping = require('ping')
const net = require('net')
var http = require('http')



///////////////////////////////////////////////////////////////// GLOBAL
var gc = ini.parse(fs.readFileSync('nhc.conf', 'utf-8'))



///////////////////////////////////////////////////////////////// LOGIC
var firstrun = function (gc, callback) {
    /*
        do the first-run operations.
        - generate cache file
        - generate bad_hosts file
        - generate logfile
    */
    if (gc.global.firstrun == 1 || gc.global.firstrun == '1') {
        fs.writeFileSync(gc.global.cache, '')
        fs.writeFileSync(gc.global.bad_hosts, '')
        fs.writeFileSync(gc.global.log, '')
        gc.global.firstrun = 0
        fs.writeFileSync('nhc.conf', ini.stringify(gc))
        callback(null)
    } else {
        callback(null)
    }
}

var ts = function () {
    return new Date()
}

var log = function (message, code, errtext, callback) {
    /*
        logging function, outputs in a JSON object for each line
    */
    var msg = {}
    msg.timestamp = new Date().toString()
    msg.code = code
    msg.message = message
    msg.err = errtext
    fs.appendFile(gc.global.log, JSON.stringify(msg) + '\n', encoding='utf-8', function (err) {
        if (err) {
            console.log(err)
            callback(err)
        } else {
            callback(null)
        }
    })
}

var server_add = function (stream, server, callback) {
    /*
        places a server into an upstream pool after it comes back up
    */
    nx.create(gc.global.nginx_conf, function (err, config) {
        if (err) {
            log('Error in pool_add', '200', err, function (err) { if (err) { console.log(err)}})
            console.log(err)
            callback(err)
        }
        for (i=0; i < config.nginx.http.upstream.length; i++) {
            if (config.nginx.http.upstream[i]._value == stream) {
                // check to see if its already in the stream
                try {
                    for (v = 0; v < config.nginx.http.upstream[i].server.length; v++) {
                        if (config.nginx.http.upstream[i].server[v]._value == server) {
                            callback(new Error(server + ' already exists in upstream pool ' + stream))
                            return
                        }
                    }
                }
                catch (e) {
                    // catch exception because server object has no .length if its empty
                }
                // if it doesn't exist, then push it to the config
                config.nginx.http.upstream[i]._add('server', server)
                log('Added server ' + server + ' to upsream pool ' + stream, '100', ' ', function (err) { if (err) { console.log(err)}})
                config.flush()
                callback(null)
                return
            }
        }
        callback(new Error(stream + ' does not exist!'))
    })
}

var server_delete = function (stream, server, callback) {
    /*
        removes a server from the upstream pool if its down
    */
    nx.create(gc.global.nginx_conf, function (err, config) {
        if (err) {
            log('Error in pool_delete', '201', err, function (err) { if (err) { console.log(err)}})
            console.log(err)
            callback(err)
        }
        for (i=0; i < config.nginx.http.upstream.length; i++) {
            if (config.nginx.http.upstream[i]._value == stream) {
                // check to see if its already in the stream
                for (v = 0; v < config.nginx.http.upstream[i].server.length; v++) {
                    if (config.nginx.http.upstream[i].server[v]._value == server) {
                        config.nginx.http.upstream[i]._remove('server', v)
                        config.flush()
                        callback(null)
                        return
                    }
                }
                // if it doesn't exist, then push it to the config
                callback(new Error(server + " doesn't exist in upstream pool " + stream))
            }
        }
    })
}

var populate_cache = function (callback) {
    /*
        populates the cache file with JSON objects of each server in the upstream
    */
    nx.create(gc.global.nginx, function (err, config) {
        if (err) {
            log('Error in populate_cache', '500', err, function (err) { if (err) { console.log(err)}})
            console.log(err)
            callback(err)
        } 
        fs.writeFileSync(gc.global.cache, '')
        for (i = 0; i < config.nginx.http.upstream.length; i++) {
            for (s = 0; s < config.nginx.http.upstream[i].server.length; s++) {
                server = {}
                group = config.nginx.http.upstream[i].server[s]._value.split(':')
                server.ip = group[0]
                server.port = group[1]
                server.pool = config.nginx.http.upstream[i]._value
                console.log(server)
                fs.appendFileSync(gc.global.cache, JSON.stringify(server) + '\n', encoding='utf-8')
            }

        }
        callback(null)
    })
}

var check_icmp = function (ip, callback) {
    /*
        uses ICMP (ping) to check if host is alive
    */
    ping.sys.probe(ip, function(isAlive) {
        callback(null, isAlive)
    })
}

var check_tcp = function (ip, port, callback) {
    /*
        uses a TCP socket to check if a host is alive & closes the socket on good connection
    */
    var tcp = net.createConnection({
        host: ip,
        port: port
    }, function () {
        tcp.end()
        return callback(null, true)
    })
    tcp.on('error', function () {
        console.log('not-connected')
        return callback(null, false)
    })

}

var check_http = function (ip, port, url, callback) {
    /*
        uses an HTTP GET to check if a host is alive
        expects HTTP/200 as a successful result
    */
    var options = {
        host: ip,
        port: port,
        path: url,
    }
    http.get(options, function (res) {
        if (res.statusCode == 200) {
            return callback(null, true)
        }
    }).on('error', function (err) {
        return callback(err, false)
    })
}

var check_host = function (ip, port, url, method, callback) {
    /*
        wrapper for check-methods that is method-agnostic
    */
    if (method == 'tcp') {
        check_tcp(ip, port, function (err, result) {
            if (err) {
                callback(err)
            } else {
                if (result == true) {
                    callback(null, true)
                } else {
                    callback(null, false)
                }
                
            }
        }) 
    }
    if (method == 'icmp') {
        check_icmp(ip, function (err, result) {
            if (result = true) {
                callback(null, true)
            } else {
                callback(null, false)
            }
        })
    }
    if (method == 'http') {
        check_http(ip, port, url, function (err, result) {
            if (result == true) {
                callback(null, true)
            } else {
                callback(null, false)
            }
        })
    }
}


var _main = function () {
    /*
        this is the main function. does these things:
        - refreshes the host cache
        - 
    */
    log('Beginning _main.', '200', null, function (err) { if (err) { console.log(err)}})
    populate_cache(function (err) {
        if (err) {
            log('Error refreshing cache', '500', err, function (err) { if (err) { console.log(err)}})
        } else {
            var hosts = fs.readFileSync(gc.global.cache, 'utf-8')
            /// todo:
            /// conform $hosts to JSON
            /// iterate through $hosts to see if they're up
            /// place the bad hosts in gc.global.bad_hosts with a timestamp
            /// iterate through the bad hosts
            /// if any bad hosts are older than threshold and still down, remove them from nginx config
            /// if any bad hosts older than threshold are up, add them to nginx config & remove from bad hosts
            /// if any bad hosts are younger than threshold and are up, remove from bad hosts
            /// if any bad hosts are younger than threshold and are down, do nothing
            ///
            /// create daemon wrapper around _main()
        }
    })




}