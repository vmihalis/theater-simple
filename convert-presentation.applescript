on run argv
    if (count of argv) is not 2 then error "Input and output paths are required."
    set inputFile to POSIX file (item 1 of argv) as alias
    set outputFile to POSIX file (item 2 of argv)
    tell application "Microsoft PowerPoint"
        launch
        open inputFile
        set openedDeck to active presentation
        save openedDeck in outputFile as save as PDF
        try
            close openedDeck saving no
        end try
    end tell
end run
