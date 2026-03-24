namespace Ai.Tlbx.MidTerm.Settings;

public sealed class TerminalColorSchemeDefinition
{
    public string Name { get; set; } = "";
    public string Background { get; set; } = "#05050A";
    public string Foreground { get; set; } = "#E0E2F0";
    public string Cursor { get; set; } = "#E0E2F0";
    public string CursorAccent { get; set; } = "#05050A";
    public string SelectionBackground { get; set; } = "#2D3044";
    public string ScrollbarSliderBackground { get; set; } = "rgba(58, 62, 82, 0.5)";
    public string ScrollbarSliderHoverBackground { get; set; } = "rgba(123, 162, 247, 0.5)";
    public string ScrollbarSliderActiveBackground { get; set; } = "rgba(123, 162, 247, 0.7)";
    public string Black { get; set; } = "#1C1E2A";
    public string Red { get; set; } = "#F07A8D";
    public string Green { get; set; } = "#8FD694";
    public string Yellow { get; set; } = "#E8B44C";
    public string Blue { get; set; } = "#7BA2F7";
    public string Magenta { get; set; } = "#9D8CFF";
    public string Cyan { get; set; } = "#7DCFFF";
    public string White { get; set; } = "#D4D7E8";
    public string BrightBlack { get; set; } = "#767B94";
    public string BrightRed { get; set; } = "#F5A962";
    public string BrightGreen { get; set; } = "#A8E5AD";
    public string BrightYellow { get; set; } = "#F5C97A";
    public string BrightBlue { get; set; } = "#8FB5FF";
    public string BrightMagenta { get; set; } = "#B5A8FF";
    public string BrightCyan { get; set; } = "#9DDDFF";
    public string BrightWhite { get; set; } = "#E0E2F0";

    internal static TerminalColorSchemeDefinition? Normalize(TerminalColorSchemeDefinition? scheme)
    {
        if (scheme is null)
        {
            return null;
        }

        var name = NormalizeRequiredString(scheme.Name, fallback: "");
        if (string.IsNullOrWhiteSpace(name))
        {
            return null;
        }

        return new TerminalColorSchemeDefinition
        {
            Name = name,
            Background = NormalizeRequiredString(scheme.Background, "#05050A"),
            Foreground = NormalizeRequiredString(scheme.Foreground, "#E0E2F0"),
            Cursor = NormalizeRequiredString(scheme.Cursor, "#E0E2F0"),
            CursorAccent = NormalizeRequiredString(scheme.CursorAccent, "#05050A"),
            SelectionBackground = NormalizeRequiredString(scheme.SelectionBackground, "#2D3044"),
            ScrollbarSliderBackground = NormalizeRequiredString(scheme.ScrollbarSliderBackground, "rgba(58, 62, 82, 0.5)"),
            ScrollbarSliderHoverBackground = NormalizeRequiredString(scheme.ScrollbarSliderHoverBackground, "rgba(123, 162, 247, 0.5)"),
            ScrollbarSliderActiveBackground = NormalizeRequiredString(scheme.ScrollbarSliderActiveBackground, "rgba(123, 162, 247, 0.7)"),
            Black = NormalizeRequiredString(scheme.Black, "#1C1E2A"),
            Red = NormalizeRequiredString(scheme.Red, "#F07A8D"),
            Green = NormalizeRequiredString(scheme.Green, "#8FD694"),
            Yellow = NormalizeRequiredString(scheme.Yellow, "#E8B44C"),
            Blue = NormalizeRequiredString(scheme.Blue, "#7BA2F7"),
            Magenta = NormalizeRequiredString(scheme.Magenta, "#9D8CFF"),
            Cyan = NormalizeRequiredString(scheme.Cyan, "#7DCFFF"),
            White = NormalizeRequiredString(scheme.White, "#D4D7E8"),
            BrightBlack = NormalizeRequiredString(scheme.BrightBlack, "#767B94"),
            BrightRed = NormalizeRequiredString(scheme.BrightRed, "#F5A962"),
            BrightGreen = NormalizeRequiredString(scheme.BrightGreen, "#A8E5AD"),
            BrightYellow = NormalizeRequiredString(scheme.BrightYellow, "#F5C97A"),
            BrightBlue = NormalizeRequiredString(scheme.BrightBlue, "#8FB5FF"),
            BrightMagenta = NormalizeRequiredString(scheme.BrightMagenta, "#B5A8FF"),
            BrightCyan = NormalizeRequiredString(scheme.BrightCyan, "#9DDDFF"),
            BrightWhite = NormalizeRequiredString(scheme.BrightWhite, "#E0E2F0")
        };
    }

    private static string NormalizeRequiredString(string? value, string fallback)
    {
        return string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
    }
}
