'use strict';

var P = require('bluebird');
var _ = require('lodash');
var should = require('should');
var env = require('../env');
var Database = require('../../app/database');
var logger = require('memdb-logger').getLogger('test', __filename);

describe('database test', function(){
    beforeEach(env.flushdb);
    after(env.flushdb);

    // it('find/update/insert/remove/commit/rollback', function(cb){
    //  //tested in ../lib/connection
    // });

    // it('index test', function(cb){
    //  //tested in ../lib/connection
    // });

    it('persistent / idle timeout / find cached', function(cb){
        var config1 = env.dbConfig('s1');
        config1.persistentDelay = 100;
        var db1 = new Database(config1);

        var config2 = env.dbConfig('s2');
        config2.idleTimeout = 200;
        var db2 = new Database(config2);

        var conn1 = null, conn2 = null;

        var collName = 'player', doc = {_id : '1', name : 'rain'};
        return P.try(function(){
            return P.all([db1.start(), db2.start()]);
        })
        .then(function(){
            conn1 = db1.connect();
            conn2 = db2.connect();
        })
        .then(function(conn){
            return db1.insert(conn1, collName, doc);
        })
        .then(function(){
            return db1.commit(conn1);
        })
        .delay(500) // doc persistented
        .then(function(){
            // read from backend
            return db2.findCached(conn2, collName, doc._id)
            .then(function(ret){
                ret.should.eql(doc);
            });
        })
        .then(function(){
            // get from cache
            return db2.findCached(conn2, collName, doc._id)
            .then(function(ret){
                ret.should.eql(doc);
            });
        })
        .then(function(){
            return db2.remove(conn2, collName, doc._id);
        })
        .then(function(){
            return db2.commit(conn2);
        })
        .delay(500) // doc idle timed out, should persistented
        .then(function(){
            return db1.findCached(conn1, collName, doc._id)
            .then(function(ret){
                (ret === null).should.eql(true);
            });
        })
        .then(function(){
            return P.all([db1.stop(), db2.stop()]);
        })
        .nodeify(cb);
    });

    it('restore from slave', function(cb){
        var db1 = null, db2 = null;
        var connId = null;
        var player1 = {_id : 'p1', name : 'rain', age: 30};
        var player2 = {_id : 'p2', name : 'snow', age: 25};

        return P.try(function(){
            var config = env.dbConfig('s1');
            config.heartbeatInterval = -1; // disable heartbeat
            config.gcInterval = 3600 * 1000; // disable gc
            db1 = new Database(config);
            return db1.start();
        })
        .then(function(){
            connId = db1.connect();
        })
        .then(function(){
            return db1.insert(connId, 'player', player1);
        })
        .then(function(){
            return db1.insert(connId, 'player', player2);
        })
        .then(function(){
            return db1.commit(connId);
        })
        .then(function(){
            db1.shard.state = 4; // Db is suddenly stopped
        })
        .then(function(){
            //restart db
            db2 = new Database(env.dbConfig('s1'));
            return db2.start();
        })
        .then(function(){
            connId = db2.connect();
        })
        .then(function(){
            return P.try(function(){
                return db2.find(connId, 'player', player1._id);
            })
            .then(function(ret){
                ret.should.eql(player1);
            });
        })
        .then(function(){
            return P.try(function(){
                return db2.find(connId, 'player', player2._id);
            })
            .then(function(ret){
                ret.should.eql(player2);
            });
        })
        .then(function(){
            return db2.stop();
        })
        .finally(function(){
            // clean up
            db1.shard.state = 2;
            return db1.stop(true);
        })
        .nodeify(cb);
    });
});
