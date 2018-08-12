var _ = require('lodash');
var moment = require('moment');
var Promise = require('bluebird');
var debug = require('debug')('lib:events');
var os = require('os');
var fs = Promise.promisifyAll(require('fs'));
var nconf = require('nconf');

var signer = require('nacl-signature');
var bs58 = require('bs58');

var mongo = require('./mongo');
var utils = require('./utils');
var alarms = require('./alarms');


function hasError(retDict) {
    return (!_.isUndefined(_.get(retDict, 'error')));
};

function reportError(where, err) {
    debug("%s Error detected and raised %s: %s",
        req.randomUnicode, where, err);
    return alarms.reportAlarm({
        caller: 'events',
        what: where,
        info: err
    })
    .then(function() {
        throw new Error(where + '-' + err);
    });
};

function processHeaders(received, required) {
    var ret = {};
    var errs = _.map(required, function(destkey, headerName) {
        var r = _.get(received, headerName);
        if(_.isUndefined(r))
            return headerName;

        _.set(ret, destkey, r);
        return null;
    });
    errs = _.compact(errs);
    if(_.size(errs)) {
        debug("Error in processHeaders: %j", errs);
        return { 'errors': errs };
    }
    return ret;
};

function saveVideo(body, supporter) {

    var id = utils.hash({
        cookieId: supporter.cookieId,
        page: body.element,
        random: _.random(0, 0xffff)
    });
    var isVideo = body.href.match(/v=/) ? true : false;
    var fdest = 'htmls/' + moment().format("YYYY-MM-DD") + "/" + id + ".html";
    var video = {
        id: id,
        href: body.href,
        isVideo: isVideo,
        htmlOnDisk: fdest,
        incremental: body.incremental,
        cookieId: supporter.cookieId,
        publicKey: supporter.publicKey,
        tagId: body.tagId,
        clientTime: new Date(body.clientTime),
        savingTime: new Date(),
    };

    if(isVideo)
        video.videoId = _.replace(body.href, /.*v=/, '');

    debug("Saving video %d (id %s) for user %s in file %s (%d bytes)",
        video.incremental, video.videoId, video.cookieId, fdest, _.size(body.element)
    );

    return Promise.all([
        mongo.writeOne(nconf.get('schema').videos, video),
        fs.writeFileAsync(fdest, body.element)
    ])
    .return(video.incremental);
};

function processEvents(req) {

    debug("Processing event");

    var headers = processHeaders(_.get(req, 'headers'), {
        'content-length': 'length',
        'x-yttrex-build': 'build',
        'x-yttrex-version': 'version',
        'x-yttrex-userid': 'supporterId',
        'x-yttrex-publickey': 'publickey',
        'x-yttrex-signature': 'signature'
    });

    if(hasError(headers))
        reportError('header parsing, missing', headers.error);

    var cookieId = _.get(req.headers, 'x-yttrex-userid');

    return mongo
        .read(nconf.get('schema').supporters, {
            cookieId: cookieId,
            publicKey: headers.publickey
        })
        .then(function(supporterL) {
            if(!_.size(supporterL)) {
                debug("new cookie+publicKey combo");
                var supporter = {
                    cookieId: cookieId,
                    publicKey: headers.publickey,
                    keyTime: new Date(),
                };
                return mongo
                    .writeOne(nconf.get('schema').supporters, supporter)
                    .return( [ supporter ] )
            }
            return supporterL;
        })
        .then(_.first)
        .then(function(supporter) {
            if (!utils.verifyRequestSignature(req)) {
                debug("Verification fail: signed %s pubkey %s user %d",
                    headers.signature, supporter.publicKey, supporter.userId);
                throw new Error('Signature does not match request body');
            }

            /* verification went well! */
            if(supporter.version !== headers.version) {
                debug("Supporter %s version upgrade from %s to %s",
                    supporter.userId, supporter.version, headers.version);
            }
            supporter.version = headers.version;
            return supporter;
        })
        .tap(function(supporter) {
            /* directory check */
            var ddest = 'htmls/' + moment().format("YYYY-MM-DD") + "/";

            return fs
                .mkdirAsync(ddest).catch(function(e) { });
        })
        .then(function(supporter) {
            return Promise.map(req.body, function(video) {
                return saveVideo(video, supporter);
            });
        })
        .then(function(results) {
            return { "json": {
                "status": "OK",
                "info": results
            }};
        })
        .catch(function(error) {
            debug("Event submission ignored: %s", error.message);
            return { 'json': {
                'status': 'error',
                'info': error.message
            }};
        });
};

module.exports = {
    processEvents: processEvents
};