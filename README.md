# exquisite

[SQS](http://aws.amazon.com/sqs/)-powered offline tasks. xsqst.

## Usage

```javascript
var exquisite = require("exquisite");

var worker = exquisite({
  name: "test" // queue name; if a queue does not exist with this name it will
               // be created
}, function(task, callback) {
  console.log("worker #1:", task);

  // extend the reservation on the current task by 30s
  this.extend(30);

  return setTimeout(callback, 5000);
});

// stop a worker from receiving new tasks
worker.cancel();

// start up a 2nd consumer
exquisite({
  name: "test" // queue name; if a queue does not exist with this name it will
               // be created
}, function(task, callback) {
  console.log("worker #2:", task);

  return setTimeout(callback, 2500);
});

//
// queue management functions are also exposed
//

// get the current status of the queue (NOTE: these are approximate values)
worker.queue.getLength(function(err, total, active) {});

// queue a task
worker.queue.queueTask({
  foo: "bar"
}, {
  maxAttempts: 2
}, function(err) {});

// delete the queue
worker.queue.delete(function(err) {});
```

A worker has 30s by default to complete a task before it becomes available to
another worker. If you know that it will take longer, use `this.extend()`
within the worker function to extend your exclusivity on a task. Calling this
repeatedly will add the extension to the visibility timeout. If a task fails
and is retried, its visibility timeout will be reset.  (This uses SQS's
`VisibilityTimeout` attribute internally.)

Tasks will be re-queued when the worker's callback is passed an `Error` (as the
first argument) or when the visibility timeout expires. Tasks will be executed
up to `maxAttempts` times (which defaults to `1`).  If your worker experiences
a reproducible error when processing a task, your best option is to mark the
task as complete and log the error elsewhere rather than continuing to let it
fail.

To manage a queue:

```javascript
var queue = require("exquisite")({
  name: "test"
}).queue;

setInterval(function() {
  queue.getLength(function(err, total, active) {
    console.log("Queue length: %d (%d active)", total, active);
  });
}, 1000).unref();

var taskCount = 50;
var status = setInterval(function() {
  if (taskCount-- > 0) {
    queue.queueTask({
      foo: "bar",
      date: new Date()
    }, {
      maxAttempts: 2
    });
  } else {
    clearInterval(status);
  }
}, 100);

process.on("SIGINT", function() {
  console.log("Deleting queue");
  clearInterval(status);
  queue.delete(process.exit);
});
```

## Configuration

### AWS

exquisite uses [aws-sdk](http://aws.amazon.com/javascript/) under the hood, so
all [configuration
methods](http://docs.aws.amazon.com/AWSJavaScriptSDK/guide/node-configuring.html)
for that also apply here. We typically use environment variables (see below).

## Environment Variables

* `AWS_ACCESS_KEY_ID` - An AWS access key with sufficient permission to create
  and delete queues as well as send, receive, and update messages (specifically
  visibility).
* `AWS_SECRET_ACCESS_KEY` - Secret access key.
* `AWS_DEFAULT_REGION` - AWS region to use. Defaults to `us-east-1`.
