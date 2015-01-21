"use strict";

var assert = require("assert"),
    EventEmitter = require("events").EventEmitter,
    stream = require("stream"),
    util = require("util");

var _ = require("highland"),
    AWS = require("aws-sdk");

AWS.config.update({
  region: process.env.AWS_DEFAULT_REGION || "us-east-1"
});

var sqs = new AWS.SQS();

var Worker = function(fn) {
  stream.Writable.call(this, {
    objectMode: true,
    highWaterMark: 1 // limit the number of buffered tasks
  });

  this._write = function(task, _, callback) {
    var payload = task.data;

    // allow workers to mark a task as known to be in progress for an estimate
    // future duration
    var ctx = {
      extend: function(time) {
        sqs.changeMessageVisibility({
          QueueUrl: task.queueUrl,
          ReceiptHandle: task.receiptHandle,
          VisibilityTimeout: time
        }, function(err) {
          if (err) {
            console.warn(err.stack);
          }
        });
      }
    };

    return fn.call(ctx, payload, function(err) {
      if (err) {
        console.warn(err.stack);

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
 * * name - Queue name (required)
 * * delay - Delay (in seconds) before queueing tasks. Defaults to 0.
 * * visibilityTimeout - Max expected task time. Defaults to 30.
 */
module.exports = function(options, fn) {
  assert.ok(options.name, "options.name is required");

  options.delay = options.delay || 0;
  options.visibilityTimeout = options.visibilityTimeout || 30;

  var worker = new EventEmitter(),
      queueUrl;

  sqs.createQueue({
    QueueName: options.name,
    Attributes: {
      DelaySeconds: options.delay.toString(),
      ReceiveMessageWaitTimeSeconds: "20",
      VisibilityTimeout: options.visibilityTimeout.toString()
    }
  }, function(err, data) {
    if (err) {
      console.warn(err.stack);
      return;
    }

    queueUrl = data.QueueUrl;
  });

  var getQueueUrl = function(callback) {
    if (queueUrl) {
      return callback(null, queueUrl);
    }

    return setImmediate(getQueueUrl, callback);
  };

  var source = _(function(push, next) {
    return getQueueUrl(function(err, queueUrl) {
      return sqs.receiveMessage({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        AttributeNames: ["ApproximateFirstReceiveTimestamp",
                         "ApproximateReceiveCount",
                         "SentTimestamp"]
      }, function(err, data) {
        if (err) {
          console.warn(err.stack);
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

              if (attempts > payload.maxAttempts) {
                // fire and forget
                sqs.deleteMessage({
                  QueueUrl: queueUrl,
                  ReceiptHandle: msg.ReceiptHandle
                }, function(err) {
                  if (err) {
                    console.warn(err);
                  }
                });

                return;
              }

              return {
                queueUrl: queueUrl,
                messageId: msg.MessageId,
                receiptHandle: msg.ReceiptHandle,
                attributes: msg.Attributes,
                attempts: attempts,
                data: payload.data
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
    });
  });

  var queueTask = function(data, options, callback) {
    options = options || {};
    callback = callback || function(err) {
      if (err) {
        console.warn(err.stack);
      }
    };

    var payload = {
      maxAttempts: options.maxAttempts || 1,
      data: data
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
