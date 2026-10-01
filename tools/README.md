Generated copies. Author these in the Flight-and-Fight repo under
food-macros/crawl/culvers/ and deploy them here the same way index.html is.
The workflow runs HERE because this repo is public: its own GITHUB_TOKEN can
commit menu-feed.json, and the app fetches the feed from its own origin, so no
secret is needed. See that directory README for what the pipeline will and
will not do.
