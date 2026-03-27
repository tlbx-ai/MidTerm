namespace Ai.Tlbx.MidTerm.Settings;

public sealed class TerminalColorSchemeDefinition
{
    public string Name { get; set; } = "";
    public string Background { get; set; } = "#0C0C0C";
    public string Foreground { get; set; } = "#CCCCCC";
    public string Cursor { get; set; } = "#CCCCCC";
    public string CursorAccent { get; set; } = "#0C0C0C";
    public string SelectionBackground { get; set; } = "#2D3044";
    public string ScrollbarSliderBackground { get; set; } = "rgba(58, 62, 82, 0.5)";
    public string ScrollbarSliderHoverBackground { get; set; } = "rgba(123, 162, 247, 0.5)";
    public string ScrollbarSliderActiveBackground { get; set; } = "rgba(123, 162, 247, 0.7)";
    public string Black { get; set; } = "#0C0C0C";
    public string Red { get; set; } = "#C50F1F";
    public string Green { get; set; } = "#13A10E";
    public string Yellow { get; set; } = "#C19C00";
    public string Blue { get; set; } = "#0037DA";
    public string Magenta { get; set; } = "#881798";
    public string Cyan { get; set; } = "#3A96DD";
    public string White { get; set; } = "#3A96DD";
    public string BrightBlack { get; set; } = "#767676";
    public string BrightRed { get; set; } = "#E74856";
    public string BrightGreen { get; set; } = "#16C60C";
    public string BrightYellow { get; set; } = "#F9F1A5";
    public string BrightBlue { get; set; } = "#3B78FF";
    public string BrightMagenta { get; set; } = "#B4009E";
    public string BrightCyan { get; set; } = "#61D6D6";
    public string BrightWhite { get; set; } = "#F2F2F2";

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
            Background = NormalizeRequiredString(scheme.Background, "#0C0C0C"),
            Foreground = NormalizeRequiredString(scheme.Foreground, "#CCCCCC"),
            Cursor = NormalizeRequiredString(scheme.Cursor, "#CCCCCC"),
            CursorAccent = NormalizeRequiredString(scheme.CursorAccent, "#0C0C0C"),
            SelectionBackground = NormalizeRequiredString(scheme.SelectionBackground, "#2D3044"),
            ScrollbarSliderBackground = NormalizeRequiredString(scheme.ScrollbarSliderBackground, "rgba(58, 62, 82, 0.5)"),
            ScrollbarSliderHoverBackground = NormalizeRequiredString(scheme.ScrollbarSliderHoverBackground, "rgba(123, 162, 247, 0.5)"),
            ScrollbarSliderActiveBackground = NormalizeRequiredString(scheme.ScrollbarSliderActiveBackground, "rgba(123, 162, 247, 0.7)"),
            Black = NormalizeRequiredString(scheme.Black, "#0C0C0C"),
            Red = NormalizeRequiredString(scheme.Red, "#C50F1F"),
            Green = NormalizeRequiredString(scheme.Green, "#13A10E"),
            Yellow = NormalizeRequiredString(scheme.Yellow, "#C19C00"),
            Blue = NormalizeRequiredString(scheme.Blue, "#0037DA"),
            Magenta = NormalizeRequiredString(scheme.Magenta, "#881798"),
            Cyan = NormalizeRequiredString(scheme.Cyan, "#3A96DD"),
            White = NormalizeRequiredString(scheme.White, "#3A96DD"),
            BrightBlack = NormalizeRequiredString(scheme.BrightBlack, "#767676"),
            BrightRed = NormalizeRequiredString(scheme.BrightRed, "#E74856"),
            BrightGreen = NormalizeRequiredString(scheme.BrightGreen, "#16C60C"),
            BrightYellow = NormalizeRequiredString(scheme.BrightYellow, "#F9F1A5"),
            BrightBlue = NormalizeRequiredString(scheme.BrightBlue, "#3B78FF"),
            BrightMagenta = NormalizeRequiredString(scheme.BrightMagenta, "#B4009E"),
            BrightCyan = NormalizeRequiredString(scheme.BrightCyan, "#61D6D6"),
            BrightWhite = NormalizeRequiredString(scheme.BrightWhite, "#F2F2F2")
        };
    }

    private static string NormalizeRequiredString(string? value, string fallback)
    {
        return string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
    }
}
