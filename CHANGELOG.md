# Changes

## v1.1.0

* Use SQS dead letter queues for failed tasks (set using `maxAttempts` when
  calling `exquisite()` to create workers
* Manage task reservation extension internally
* Deprecate `Worker.extend`

## v1.0.0 - 1/6/15

* Initial public version
