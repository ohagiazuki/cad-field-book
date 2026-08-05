Attribute VB_Name = "PhotoLedgerImport"
Option Explicit

' Import ledger.csv and its photos into the active photo-ledger template.
' The template layout is one record per 14 rows:
' photo = columns B:E, values = columns H:I, memo = columns F:I.
Public Sub ImportPhotoLedgerPackage()
    Dim targetBook As Workbook
    Dim targetSheet As Worksheet
    Dim csvPath As Variant
    Dim csvBook As Workbook
    Dim csvSheet As Worksheet
    Dim lastRow As Long
    Dim sourceRow As Long
    Dim recordIndex As Long
    Dim blockRow As Long
    Dim packageFolder As String
    Dim photoPath As String

    Set targetBook = ActiveWorkbook
    Set targetSheet = ActiveSheet

    csvPath = Application.GetOpenFilename("CSV Files (*.csv),*.csv", , "Select ledger.csv")
    If VarType(csvPath) = vbBoolean Then Exit Sub
    packageFolder = Left$(CStr(csvPath), InStrRev(CStr(csvPath), Application.PathSeparator))

    Application.ScreenUpdating = False
    Application.DisplayAlerts = False
    DeleteImportedPhotos targetSheet

    Workbooks.OpenText Filename:=CStr(csvPath), Origin:=65001, DataType:=xlDelimited, _
        TextQualifier:=xlTextQualifierDoubleQuote, Comma:=True, Local:=True
    Set csvBook = ActiveWorkbook
    Set csvSheet = csvBook.Worksheets(1)
    lastRow = csvSheet.Cells(csvSheet.Rows.Count, 1).End(xlUp).Row

    For sourceRow = 2 To lastRow
        recordIndex = sourceRow - 2
        blockRow = 3 + recordIndex * 14

        targetSheet.Cells(blockRow, 8).Value = CsvText(csvSheet.Cells(sourceRow, 1).Value)
        targetSheet.Cells(blockRow + 1, 8).Value = CsvText(csvSheet.Cells(sourceRow, 2).Value)
        targetSheet.Cells(blockRow + 2, 8).Value = CsvText(csvSheet.Cells(sourceRow, 3).Value)
        targetSheet.Cells(blockRow + 3, 8).Value = CsvText(csvSheet.Cells(sourceRow, 4).Value)
        targetSheet.Cells(blockRow + 4, 8).Value = CsvText(csvSheet.Cells(sourceRow, 5).Value)
        targetSheet.Cells(blockRow + 6, 6).Value = CsvText(csvSheet.Cells(sourceRow, 6).Value)

        photoPath = packageFolder & Replace(CsvText(csvSheet.Cells(sourceRow, 7).Value), "/", Application.PathSeparator)
        If Len(Dir$(photoPath)) > 0 Then
            InsertPhotoInBlock targetSheet, photoPath, blockRow, recordIndex + 1
        End If
    Next sourceRow

    csvBook.Close SaveChanges:=False
    targetBook.Activate
    targetSheet.Activate
    Application.DisplayAlerts = True
    Application.ScreenUpdating = True
    MsgBox CStr(lastRow - 1) & " records imported.", vbInformation
End Sub

Private Function CsvText(ByVal value As Variant) As String
    If IsError(value) Or IsEmpty(value) Then
        CsvText = ""
    Else
        CsvText = CStr(value)
    End If
End Function

Private Sub DeleteImportedPhotos(ByVal ws As Worksheet)
    Dim i As Long
    For i = ws.Shapes.Count To 1 Step -1
        If Left$(ws.Shapes(i).Name, 9) = "CF_Photo_" Then ws.Shapes(i).Delete
    Next i
End Sub

Private Sub InsertPhotoInBlock(ByVal ws As Worksheet, ByVal photoPath As String, _
                               ByVal blockRow As Long, ByVal photoIndex As Long)
    Dim target As Range
    Dim picture As Shape
    Dim scaleValue As Double
    Dim maxWidth As Double
    Dim maxHeight As Double

    Set target = ws.Range(ws.Cells(blockRow, 2), ws.Cells(blockRow + 13, 5))
    Set picture = ws.Shapes.AddPicture(photoPath, msoFalse, msoTrue, _
        target.Left, target.Top, -1, -1)
    picture.Name = "CF_Photo_" & Format$(photoIndex, "0000")
    picture.LockAspectRatio = msoTrue

    maxWidth = target.Width - 6
    maxHeight = target.Height - 6
    scaleValue = 1
    If picture.Width > maxWidth Then scaleValue = maxWidth / picture.Width
    If picture.Height * scaleValue > maxHeight Then scaleValue = maxHeight / picture.Height
    picture.Width = picture.Width * scaleValue
    picture.Height = picture.Height * scaleValue
    picture.Left = target.Left + (target.Width - picture.Width) / 2
    picture.Top = target.Top + (target.Height - picture.Height) / 2
    picture.Placement = xlMoveAndSize
End Sub
