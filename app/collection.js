'use strict';

var Q = require('q');
var util = require('util');
var EventEmitter = require('events').EventEmitter;
var util = require('util');
var logger = require('pomelo-logger').getLogger('memorydb', __filename);

/**
 * opts.indexes - [field, field]
 *
 */
var Collection = function(opts){
	var self = this;

	this.name = opts.name;
	this.shard = opts.shard;
	this.db = opts.db;
	this.config = opts.config || {};

	this.indexes = {}; //{field : true}
	(this.config.indexes || []).forEach(function(index){
		self.indexes[index] = true;
	});

	this.pendingIndexTasks = {}; //{id, [Promise]}

	this.shard.on('docUpdateUncommited:' + this.name, function(connId, id, field, oldValue, newValue){
		if(!!self.indexes[field]){
			if(!self.pendingIndexTasks[id]){
				self.pendingIndexTasks[id] = [];
			}
			if(oldValue !== undefined){
				self.pendingIndexTasks[id].push(self._removeIndex(connId, id, field, oldValue));
			}
			if(newValue !== undefined){
				self.pendingIndexTasks[id].push(self._insertIndex(connId, id, field, newValue));
			}
		}
	});

	EventEmitter.call(this);
};

util.inherits(Collection, EventEmitter);

var proto = Collection.prototype;

proto.insert = function(connId, id, doc){
	var self = this;
	return Q.fcall(function(){
		return self.lock(connId, id);
	}).then(function(){
		return self.shard.insert(connId, self._key(id), doc);
	}).then(function(){
		return self._finishIndexTasks(id);
	}).then(function(ret){
		logger.debug('shard[%s].collection[%s].insert(%s, %s, %j) => %s', self.shard._id, self.name, connId, id, doc, ret);
		return ret;
	});
};

proto.remove = function(connId, id){
	var self = this;
	return Q.fcall(function(){
		return self.lock(connId, id);
	}).then(function(){
		return self.shard.remove(connId, self._key(id));
	}).then(function(){
		return self._finishIndexTasks(id);
	}).then(function(ret){
		logger.debug('shard[%s].collection[%s].remove(%s, %s) => %s', self.shard._id, self.name, connId, id, ret);
		return ret;
	});
};

proto.find = function(connId, id, fields){
	var self = this;
	return Q.fcall(function(){
		return self.shard.find(connId, self._key(id), fields);
	}).then(function(ret){
		logger.debug('shard[%s].collection[%s].find(%s, %s, %s) => %j', self.shard._id, self.name, connId, id, fields, ret);
		return ret;
	});
};

proto.findForUpdate = function(connId, id, fields){
	var self = this;
	return Q.fcall(function(){
		return self.lock(connId, id);
	}).then(function(){
		return self.find(connId, id, fields);
	});
};

proto.update = function(connId, id, doc, opts){
	var self = this;
	return Q.fcall(function(){
		return self.lock(connId, id);
	}).then(function(){
		return self.shard.update(connId, self._key(id), doc, opts);
	}).then(function(){
		return self._finishIndexTasks(id);
	}).then(function(ret){
		logger.debug('shard[%s].collection[%s].update(%s, %s, %j, %j) => %s', self.shard._id, self.name, connId, id, doc, opts, ret);
		return ret;
	});
};

proto.lock = function(connId, id){
	if(this.shard.isLocked(connId, this._key(id))){
		return;
	}
	var self = this;
	return Q.fcall(function(){
		return self.shard.lock(connId, self._key(id));
	}).then(function(ret){
		self.emit('lock', connId, id);
		logger.debug('shard[%s].collection[%s].lock(%s, %s) => %s', self.shard._id, self.name, connId, id, ret);
		return ret;
	});
};

proto.findByIndex = function(connId, field, value, fields){
	var self = this;
	var indexCollection = self.db._collection(self._indexCollectionName(field));
	return Q.fcall(function(){
		return indexCollection.find(connId, value);
	})
	.then(function(ids){
		if(!ids){
			ids = {};
		}
		//TODO: this is a bug
		delete ids._id;

		return Q.all(Object.keys(ids).map(function(id){
			return self.find(connId, id, fields);
		}))
		.then(function(ret){
			logger.debug('shard[%s].collection[%s].findByIndex(%s, %s, %s, %s) => %j', self.shard._id, self.name, connId, field, value, fields, ret);
			return ret;
		});
	});
};

proto.findCached = function(connId, id){
	var self = this;
	return Q.fcall(function(){
		return self.shard.findCached(connId, self._key(id));
	})
	.then(function(ret){
		logger.debug('shard[%s].collection[%s].findCached(%s, %s) => %j', self.shard._id, self.name, connId, id, ret);
		return ret;
	});
};

proto._insertIndex = function(connId, id, field, value){
	if(id === '_id'){
		//TODO: this is a bug
		throw new Error('index key "_id" not supported');
	}

	var self = this;
	var indexCollection = self.db._collection(self._indexCollectionName(field));
	return Q.fcall(function(){
		var doc = {};
		doc[id] = true;
		return indexCollection.update(connId, value, doc, {upsert : true});
	});
};

proto._removeIndex = function(connId, id, field, value){
	if(id === '_id'){
		//TODO: this is a bug
		throw new Error('index key "_id" not supported');
	}

	var self = this;
	var indexCollection = self.db._collection(self._indexCollectionName(field));
	return Q.fcall(function(){
		//TODO: Remove doc which is {}
		var doc = {};
		doc[id] = undefined;
		return indexCollection.update(connId, value, doc);
	});
};

proto._finishIndexTasks = function(id){
	var self = this;
	if(!self.pendingIndexTasks[id]){
		return;
	}
	return Q.all(self.pendingIndexTasks[id])
	.then(function(){
		delete self.pendingIndexTasks[id];
	});
};

proto._indexCollectionName = function(field){
	return '__index_' + this.name + '_' + field;
};

proto._key = function(id){
	return this.name + ':' + id;
};

module.exports = Collection;
