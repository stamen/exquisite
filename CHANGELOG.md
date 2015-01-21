# Changes

## v1.1.1 - 1/20/15

* Remove `visibilityTimeout` option for queues (obviated by task reservation
  management)

## v1.1.0 - 1/20/15

* Use SQS dead letter queues for failed tasks (set using `maxAttempts` when
  calling `exquisite()` to create workers
* Manage task reservation extension internally
* Deprecate `Worker.extend`
* Abort pending receives when canceled

## v1.0.0 - 1/6/15

* Initial public version
