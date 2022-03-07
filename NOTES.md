States:

- blank
- active
- refreshing
- waiting

Transitions:

- Start session
  - blank -> active
- Log out
  - active -> blank
- Refresh due
  - active -> refreshing
  - active -> waiting
- Refresh succeeds
  - refreshing -> active
  - waiting -> active
- Refresh fails
  - refreshing -> waiting
- Refresh timed out
  - waiting -> refreshing
- Session timed out
  - waiting -> blank
  - refreshing -> blank