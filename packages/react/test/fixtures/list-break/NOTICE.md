# list-break fixture (#183)

`cat-v2.json` is the envelope of a document made by the released ahwp 2.0.0
(/opt/homebrew/bin/ahwp, not a source build) from public Markdown written for
this test, with no third-party content:

```sh
printf '# t\n\n1. a\n2. b\n\n- c\n\n끝\n' > in.md
ahwp new --from in.md -o lb.hwpx
ahwp cat lb.hwpx --format json --with-segments --segments v2 > cat-v2.json
```

Paragraph 3 (the bullet `c`) carries the projection line `<!-- list-break -->`
inside its char_range. The playground seeds the same document as
`list-break-demo.hwpx`.
