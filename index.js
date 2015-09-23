"use strict";

var assert = require("assert"),
    EventEmitter = require("events").EventEmitter,
    https = require("https"),
    stream = require("stream"),
    util = require("util");

var _ = require("highland"),
    AWS = require("aws-sdk");

var agent = new https.Agent({
  // set this to at least the number of CPUs in order to effectively take
  // advantage of long polling in receiveMessage
  maxSockets: Infinity
});

AWS.config.update({
  httpOptions: {
    agent: agent
  },
  region: process.env.AWS_DEFAULT_REGION || "us-east-1"
});

var sqs = new AWS.SQS();

var Worker = function(fn) {
  stream.Writable.call(this, {
    objectMode: true,
    highWaterMark: 1 // limit the number of buffered tasks
  });

  this._write = function(task, encoding, callback) {
    var payload = task.data,
        extend = function(time) {
          return sqs.changeMessageVisibility({
            QueueUrl: task.queueUrl,
            ReceiptHandle: task.receiptHandle,
            VisibilityTimeout: time
          }, function(err) {
            if (err) {
              console.warn(err.stack);
            }
          });
        };

    // allow workers to mark a task as known to be in progress for an estimate
    // future duration
    var ctx = {
      extend: util.deprecate(extend, "Worker.extend: This is now handled internally.")
    };

    // extend the reservation on this task by 30s every 15s (so it expires
    // 15s after the interval is cancelled unless it's otherwise been cleared
    // for good reason)
    var extension = setInterval(_.partial(extend, 30), 15e3);

    return fn.call(ctx, payload, function(err) {
      // cancel the reservation extension
      clearInterval(extension);

      if (err) {
        // TODO publish the error message somewhere
        // console.warn(err.stack);

        // update visibility so it can be retried
        sqs.changeMessageVisibility({
          QueueUrl: task.queueUrl,
          ReceiptHandle: task.receiptHandle,
          VisibilityTimeout: 0
        }, function(err) {
          if (err) {
            console.warn(err.stack);
          }
        });
      } else {
        // delete task
        sqs.deleteMessage({
          QueueUrl: task.queueUrl,
          ReceiptHandle: task.receiptHandle
        }, function(err) {
          if (err) {
            console.warn(err.stack);
          }
        });
      }

      return callback();
    });
  };
};

util.inherits(Worker, stream.Writable);

/**
 * Available options:
 * * url - URL of existing queue (required if name is not present)
 * * name - Queue name (required if url is not present)
 * * delay - Delay (in seconds) before queueing tasks. Defaults to 0.
 * * maxAttempts - Number of attempts to make before marking a task as failed.
 */
module.exports = function(options, fn) {

  var worker = new EventEmitter(),
      queueUrl;

  if (options.url) {
    queueUrl = options.url;
  } else {
    assert.ok(options.name, "options.name is required");

    options.delay = options.delay || 0;
    options.maxAttempts = options.maxAttempts || 10;

    var createDeadLetterQueue = function(basename, callback) {
      var queueName = basename + "_failed";

      return sqs.createQueue({
        QueueName: queueName
      }, function(err, data) {
        if (err) {
          return callback(err);
        }

        return sqs.getQueueAttributes({
          QueueUrl: data.QueueUrl,
          AttributeNames: [
            "QueueArn"
          ]
        }, function(err, data) {
          if (err) {
            err.QueueName = queueName;
            return callback(err);
          }

          return callback(null, data.Attributes.QueueArn);
        });
      });
    };

    createDeadLetterQueue(options.name, function(err, deadletterArn) {
      if (err && err.code !== "QueueAlreadyExists") {
        return worker.emit("error", err);
      }

      return sqs.createQueue({
        QueueName: options.name,
        Attributes: {
          DelaySeconds: options.delay.toString(),
          RedrivePolicy: JSON.stringify({
            maxReceiveCount: options.maxAttempts.toString(),
            deadLetterTargetArn: deadletterArn
          }),
          ReceiveMessageWaitTimeSeconds: "20"
        }
      }, function(err, data) {
        if (err) {
          err.QueueName = options.name;
          return worker.emit("error", err);
        }

        queueUrl = data.QueueUrl;
        return queueUrl;
      });
    });
  }

  var getQueueUrl = function(callback) {
    if (queueUrl) {
      return callback(null, queueUrl);
    }

    return setImmediate(getQueueUrl, callback);
  };

  var source = _(function(push, next) {
    return getQueueUrl(function(err, queueUrl) {
      if (err) {
        push(err);
        push(null, _.nil);
        return;
      }

      var receive = sqs.receiveMessage({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        AttributeNames: ["ApproximateFirstReceiveTimestamp",
                         "ApproximateReceiveCount",
                         "SentTimestamp"]
      }, function(err, data) {
        if (err) {
          if (err.code !== "RequestAbortedError") {
            console.warn(err.stack);
          }

          return next();
        }

        if (data.Messages) {
          data.Messages
            .map(function(msg) {
              var attempts = msg.Attributes.ApproximateReceiveCount | 0,
                  payload;

              try {
                payload = JSON.parse(msg.Body);
              } catch (err) {
                console.warn(err);
                return;
              }

              return {
                queueUrl: queueUrl,
                messageId: msg.MessageId,
                receiptHandle: msg.ReceiptHandle,
                attributes: msg.Attributes,
                attempts: attempts,
                data: payload
              };
            })
            .filter(function(task) {
              // filter out tasks that failed to parse
              return !!task;
            })
            .forEach(function(task) {
              push(null, task);
            });
        }

        return next();
      });

      // cancel requests when the stream ends so we're not hanging onto any
      // outstanding resources (sqs.receiveMessages waits 30s for messages by
      // default)

      var abort = receive.abort.bind(receive);

      source.on("end", abort);

      // clean up event listeners
      receive.on("complete", _.partial(source.removeListener.bind(source), "end", abort));
    });
  });

  var queueTask = function(payload, callback) {
    callback = callback || function(err) {
      if (err) {
        console.warn(err.stack);
      }
    };

    return getQueueUrl(function(err, queueUrl) {
      return sqs.sendMessage({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(payload)
      }, function(err) {
        // client doesn't need to see the data
        return callback(err);
      });
    });
  };

  var deleteQueue = function(callback) {
    callback = callback || function(err) {
      if (err) {
        console.warn(err.stack);
      }
    };

    return getQueueUrl(function(err, queueUrl) {
      return sqs.deleteQueue({
        QueueUrl: queueUrl
      }, callback);
    });
  };

  var getLength = function(callback) {
    return getQueueUrl(function(err, queueUrl) {
      return sqs.getQueueAttributes({
        QueueUrl: queueUrl,
        AttributeNames: ["ApproximateNumberOfMessages",
                         "ApproximateNumberOfMessagesNotVisible"]
      }, function(err, data) {
        if (err) {
          return callback(err);
        }

        return callback(null,
                        data.Attributes.ApproximateNumberOfMessages,
                        data.Attributes.ApproximateNumberOfMessagesNotVisible);
      });
    });
  };

  worker.queue = {
    delete: deleteQueue,
    getLength: getLength,
    queueTask: queueTask
  };

  if (fn) {
    source.pipe(new Worker(fn));

    worker.cancel = function() {
      source.destroy();
    };
  }

  return worker;
};
