# Useful Prompts

Things you can say to your coding agent. It runs the scripts for you; you never
need to type a command.

## Activate

> Activate the Project Time Machine in this repository and use it automatically
> for every future project change, rollback and recovery.

(The full activation text is in `START_PROMPT.txt`.)

## Check state

> What is the Time Machine state? Run status and audit and tell me if anything
> is stale, unlogged or half-finished.

## Repair

> The Time Machine says a task is stuck. Work out whether it is a stale lock, an
> interrupted completion or a malformed record, then fix it safely.

## Roll back one task

> I do not like the last change. Undo only that task.

> Reverse the CSV column task, but keep everything I did afterwards.

## Restore the whole project

> Restore the whole project to the state after TASK-0004.

## Recover

> Undo the rollback and bring back all my tasks.

> Show me the available backups, then recover from the second one.

## Emergency checkpoints

> I made changes outside a task and lost them. Check the emergency checkpoints
> and restore the most recent one.

## Show history

> Show all saved, active, completed and rolled-back tasks.

> What did TASK-0003 change, and which checks were run?
