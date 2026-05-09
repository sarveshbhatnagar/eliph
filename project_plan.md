### Idea

I would like to use Automata to make agents smarter and more procedural, allowing deterministic and probabilistic guides via state and state transitions.

It will be a tool that any AI can call, allowing for agent to ask next step, seek whats needed for moving to next step, understand where it is, ability to view and update the transition graph


### Plan


### function spec

procedures(search_query) -> given a search query, returns closest available workflow names.
procedure(workflow_name) -> returns the specific workflow end to end
create_procedure(workflow_name, description) -> initializes empty workflow_name with initial state called start.
add_transition_definition(string_based_transition) -> uses string to determine states and transition, e.g. add_transition("coin_flip","start -.5-> heads") and add_transition("coin_flip", "start ->.5->tails"); will create state diagram


### API Spec

