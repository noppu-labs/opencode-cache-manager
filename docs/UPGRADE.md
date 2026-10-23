# Upgrading

## From 0.1.x

Two changes break existing habits:

1. **`/cache-ttl` is now `/cache-manager`.** The palette entry is "Cache Manager" and the old command name is gone, with no alias.
2. **Typed commands change only the current session.** `/cache-ttl 1h` used to set the global mode; `/cache-manager 1h` sets the mode for the session you are in. To change the global default, use the picker's Global section.

A global mode stored by 0.1.x is kept and takes precedence over `defaultMode`, so editing `defaultMode` alone will not change it; set it from the picker's Global section instead. There is nothing else to migrate.
